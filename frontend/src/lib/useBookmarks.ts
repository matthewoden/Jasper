/**
 * useBookmarks — composes the bookmarks/bookmarkFolders store slices with
 * GET/POST/DELETE backend calls and a WS refresh subscription on
 * `bookmark:changed`. Mirrors useMcpGrants.ts's hydrate + subscriber-bus +
 * optimistic-mutate shape.
 *
 * Public surface:
 *   - bookmarks / bookmarkFolders: current store slices
 *   - refresh():                    re-fetch GET /bookmarks
 *   - toggleBookmark(noteId):       the entry-point-agnostic seam — adds a
 *                                   bookmark if absent, removes it if present
 *                                   (breadcrumb star, palette command, future
 *                                   context menu all hang off this one call)
 *   - moveToFolder(id, folderId):   POST /bookmarks/{id}/folder, then refresh
 *   - createFolder(name):           POST /bookmark-folders, then refresh
 *   - isBookmarked(noteId):         convenience lookup for UI state
 */

import { useCallback, useEffect } from "react";
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
  refresh: () => Promise<void>;
  toggleBookmark: (noteId: string) => Promise<void>;
  moveToFolder: (id: string, folderId: string | null) => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  isBookmarked: (noteId: string) => boolean;
}

export function useBookmarks(): UseBookmarksResult {
  const bookmarks = useTreeStore((s) => s.bookmarks);
  const setBookmarks = useTreeStore((s) => s.setBookmarks);
  const bookmarkFolders = useTreeStore((s) => s.bookmarkFolders);
  const setBookmarkFolders = useTreeStore((s) => s.setBookmarkFolders);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      const doc = await getBookmarks();
      setBookmarks(doc.bookmarks);
      setBookmarkFolders(doc.folders);
    } catch {
      // Silent — preserve the existing slices so a transient backend hiccup
      // doesn't wipe the bookmarks panel.
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

  /**
   * toggleBookmark — the single entry-point seam. Reads the current slice
   * to decide add vs remove. Both branches optimistically update the local
   * slice before the network call resolves and revert + toast on failure.
   */
  const toggleBookmark = useCallback(
    async (noteId: string) => {
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

  return {
    bookmarks,
    bookmarkFolders,
    refresh,
    toggleBookmark,
    moveToFolder,
    createFolder,
    isBookmarked,
  };
}

export const __testing__ = {
  getSubscriberCount: () => bookmarksSubscribers.size,
  simulateEvent: () => dispatchBookmarksEvent(),
};
