/**
 * useBookmarks — composes the bookmarks/bookmarkFolders store slices with
 * GET/POST/DELETE backend calls and a WS refresh subscription on
 * `bookmark:changed`. Mirrors useMcpGrants.ts's hydrate + subscriber-bus +
 * optimistic-mutate shape.
 *
 * Public surface:
 *   - bookmarks / bookmarkFolders: current store slices
 *   - loading / error:              true only across the INITIAL hydrate
 *                                    window (27-UI-REVIEW #1). Once bookmarks
 *                                    have loaded successfully once, a later
 *                                    transient refresh failure (WS event,
 *                                    background hiccup) is swallowed and
 *                                    NEVER regresses the panel back to the
 *                                    error state or wipes the last-known-good
 *                                    cache — see the hydratedRef comment below.
 *   - refresh():                    re-fetch GET /bookmarks
 *   - toggleBookmark(noteId):       the entry-point-agnostic seam — adds a
 *                                   bookmark if absent, removes it if present
 *                                   (breadcrumb star, palette command, future
 *                                   context menu all hang off this one call)
 *   - moveToFolder(id, folderId):   POST /bookmarks/{id}/folder, then refresh
 *   - createFolder(name):           POST /bookmark-folders, then refresh
 *   - reorder(folderId, orderedIds): POST /bookmarks/reorder — optimistic
 *                                    in-scope reorder with revert-on-failure
 *                                    (mirrors toggleBookmark's optimistic shape)
 *   - isBookmarked(noteId):         convenience lookup for UI state
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../components/toast.utils";
import {
  useTreeStore,
  type Bookmark,
  type BookmarkFolder,
} from "./useTreeStore";
import {
  getBookmarks,
  postBookmark,
  deleteBookmark,
  postBookmarkMove,
  postBookmarkFolder,
  reorderBookmarks,
} from "./bookmarksApi";

const bookmarksSubscribers = new Set<() => void>();

/**
 * Called by useSessionSync when a `bookmark:changed` WS event arrives.
 * Iterates a snapshot of the subscriber set so mid-iteration
 * register/unregister doesn't cause a concurrent-mutation error.
 */
export function dispatchBookmarksEvent(): void {
  const snapshot = Array.from(bookmarksSubscribers);
  for (const fn of snapshot) fn();
}

export interface UseBookmarksResult {
  bookmarks: Bookmark[];
  bookmarkFolders: BookmarkFolder[];
  loading: boolean;
  error: boolean;
  refresh: () => Promise<void>;
  toggleBookmark: (noteId: string) => Promise<void>;
  moveToFolder: (id: string, folderId: string | null) => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  reorder: (folderId: string | null, orderedIds: string[]) => Promise<void>;
  isBookmarked: (noteId: string) => boolean;
}

export function useBookmarks(): UseBookmarksResult {
  const bookmarks = useTreeStore((s) => s.bookmarks);
  const setBookmarks = useTreeStore((s) => s.setBookmarks);
  const bookmarkFolders = useTreeStore((s) => s.bookmarkFolders);
  const setBookmarkFolders = useTreeStore((s) => s.setBookmarkFolders);
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // True once ANY fetch has ever succeeded. Gates whether a subsequent
  // failure surfaces `error` (initial hydrate only, 27-UI-REVIEW #1) or is
  // swallowed (every later refresh — WS `bookmark:changed` events,
  // post-mutation re-fetches — must never wipe an already-populated cache
  // on a transient backend hiccup).
  const hydratedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const doc = await getBookmarks();
      setBookmarks(doc.bookmarks);
      setBookmarkFolders(doc.folders);
      hydratedRef.current = true;
      setError(false);
    } catch {
      if (!hydratedRef.current) {
        setError(true);
      }
      // else: silent — preserve the existing slices, matching the
      // pre-existing swallow-on-refresh-failure contract.
    } finally {
      setLoading(false);
    }
  }, [setBookmarks, setBookmarkFolders]);

  useEffect(() => {
    void refresh();
    bookmarksSubscribers.add(refresh);
    return () => {
      bookmarksSubscribers.delete(refresh);
    };
  }, [refresh]);

  const isBookmarked = useCallback(
    (noteId: string): boolean => bookmarks.some((b) => b.note_id === noteId),
    [bookmarks],
  );

  // WR-07: tracks noteIds with an in-flight add/remove mutation. Guards
  // toggleBookmark against a rapid double-click racing itself — without
  // it, a second toggle before the first's network call resolves treats
  // the still-`pending-${noteId}` placeholder as `existing` and issues a
  // DELETE for an id the backend never created; that DELETE fails, state
  // reverts, and then the FIRST call's postBookmark resolves and
  // unconditionally re-adds the bookmark — silently overriding the
  // user's second click.
  const inFlightNoteIds = useRef<Set<string>>(new Set());

  /**
   * toggleBookmark — the single entry-point seam. Reads the current slice
   * to decide add vs remove. Both branches optimistically update the local
   * slice before the network call resolves and revert + toast on failure.
   * Ignores re-entrant calls for the same noteId while a mutation is
   * already in flight (WR-07) rather than racing it.
   */
  const toggleBookmark = useCallback(
    async (noteId: string) => {
      if (inFlightNoteIds.current.has(noteId)) {
        return;
      }
      inFlightNoteIds.current.add(noteId);
      try {
        const existing = bookmarks.find((b) => b.note_id === noteId);
        const previous = bookmarks;

        if (existing) {
          setBookmarks(bookmarks.filter((b) => b.id !== existing.id));
          try {
            await deleteBookmark(existing.id);
          } catch (e) {
            setBookmarks(previous);
            toast({
              title: "Couldn't remove bookmark",
              description: String(e instanceof Error ? e.message : e),
              variant: "error",
            });
          }
          return;
        }

        const optimistic: Bookmark = {
          id: `pending-${noteId}`,
          note_id: noteId,
          folder_id: null,
          order: bookmarks.length,
        };
        setBookmarks([...bookmarks, optimistic]);
        try {
          const created = await postBookmark(noteId);
          setBookmarks([...previous, created]);
        } catch (e) {
          setBookmarks(previous);
          toast({
            title: "Couldn't add bookmark",
            description: String(e instanceof Error ? e.message : e),
            variant: "error",
          });
        }
      } finally {
        inFlightNoteIds.current.delete(noteId);
      }
    },
    [bookmarks, setBookmarks, toast],
  );

  const moveToFolder = useCallback(
    async (id: string, folderId: string | null) => {
      try {
        await postBookmarkMove(id, folderId);
        await refresh();
      } catch (e) {
        toast({
          title: "Couldn't move bookmark",
          description: String(e instanceof Error ? e.message : e),
          variant: "error",
        });
      }
    },
    [refresh, toast],
  );

  const createFolder = useCallback(
    async (name: string) => {
      try {
        await postBookmarkFolder(name);
        await refresh();
      } catch (e) {
        toast({
          title: "Couldn't create folder",
          description: String(e instanceof Error ? e.message : e),
          variant: "error",
        });
      }
    },
    [refresh, toast],
  );

  /**
   * reorder — optimistically reassigns Order = index (within orderedIds)
   * for exactly the bookmarks named in orderedIds, leaving every bookmark
   * OUTSIDE that scope untouched (mirrors the backend's per-folder Order
   * semantics, WR-02). Reverts to the pre-mutation slice and toasts on
   * failure — same shape as toggleBookmark's optimistic-mutate-then-revert.
   */
  const reorder = useCallback(
    async (folderId: string | null, orderedIds: string[]) => {
      const previous = bookmarks;
      const orderIndex = new Map(orderedIds.map((id, index) => [id, index]));
      const optimistic = bookmarks.map((b) => {
        const index = orderIndex.get(b.id);
        return index === undefined ? b : { ...b, order: index };
      });
      setBookmarks(optimistic);
      try {
        await reorderBookmarks(folderId, orderedIds);
        await refresh();
      } catch (e) {
        setBookmarks(previous);
        toast({
          title: "Couldn't reorder bookmarks",
          description: String(e instanceof Error ? e.message : e),
          variant: "error",
        });
      }
    },
    [bookmarks, setBookmarks, refresh, toast],
  );

  return {
    bookmarks,
    bookmarkFolders,
    loading,
    error,
    refresh,
    toggleBookmark,
    moveToFolder,
    createFolder,
    reorder,
    isBookmarked,
  };
}

export const __testing__ = {
  getSubscriberCount: () => bookmarksSubscribers.size,
  simulateEvent: () => dispatchBookmarksEvent(),
};
