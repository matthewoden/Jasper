/**
 * useBookmarks composes the shared bookmarksResource cache with POST/DELETE
 * calls. Mounting issues no request by itself — only the resource's 0->1
 * subscriber transition and `bookmark:changed` do.
 *
 * `loading`/`error` are true only during the INITIAL hydrate. Once bookmarks
 * have loaded once, a later transient refresh failure is swallowed by the
 * resource layer's preserve-last-good-value policy.
 *
 * toggleBookmark is the entry-point-agnostic seam every caller hangs off.
 */

import { useCallback, useMemo, useRef } from "react";
import { useToast } from "../components/toast.utils";
import type { Bookmark, BookmarkFolder } from "./useTreeStore";
import {
  BookmarkFolderNameConflictError,
  bookmarksResource,
  postBookmark,
  deleteBookmark,
  postBookmarkMove,
  postBookmarkFolder,
  reorderBookmarks,
  type BookmarksDocument,
} from "./bookmarksApi";
import { publish, useResource } from "./resources";
import { __testing__ as resourcesTesting } from "./resources/createResource";

const EMPTY_DOC: BookmarksDocument = { folders: [], bookmarks: [] };
const EMPTY_BOOKMARKS: Bookmark[] = [];
const EMPTY_FOLDERS: BookmarkFolder[] = [];

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
  const snapshot = useResource(bookmarksResource);
  const { toast } = useToast();

  // snapshot.data?.x ?? [] would allocate a new array identity every render
  // when data is still undefined, which would make isBookmarked's
  // useCallback below think its deps changed each render (matches
  // useMcpGrants.ts's identical fix).
  const bookmarks = useMemo(
    () => snapshot.data?.bookmarks ?? EMPTY_BOOKMARKS,
    [snapshot.data],
  );
  const bookmarkFolders = useMemo(
    () => snapshot.data?.folders ?? EMPTY_FOLDERS,
    [snapshot.data],
  );
  // 27-UI-REVIEW #1: error surfaces on the initial hydrate only. Once
  // anything has succeeded (snapshot.hydrated), a later failure is
  // swallowed by the resource layer's preserve-last-good-value policy and
  // the populated cache stays on screen instead of flipping to the error
  // state.
  const error = snapshot.error !== null && !snapshot.hydrated;
  const loading = !snapshot.hydrated && snapshot.error === null;

  const refresh = useCallback(async () => {
    await bookmarksResource.invalidate();
  }, []);

  const isBookmarked = useCallback(
    (noteId: string): boolean => bookmarks.some((b) => b.note_id === noteId),
    [bookmarks],
  );

  // Guards toggleBookmark against racing itself on a double-click: the second
  // toggle would treat the still-pending placeholder as existing and DELETE an
  // id the backend never created, then the first call's POST would re-add it —
  // silently overriding the user's second click.
  //
  // Per-hook useRef, not module scope: promoting it would lock out every mounted
  // consumer rather than just this one.
  const inFlightNoteIds = useRef<Set<string>>(new Set());

  /**
   * toggleBookmark — the single entry-point seam. Both branches optimistically
   * update the shared cache before the network call resolves and revert +
   * toast on failure via bookmarksResource.mutate(). The add branch's commit
   * reconciles against the LIVE cache at success time (not the closed-over
   * snapshot) — this is why a bulk "Bookmark N notes" loop accumulates
   * instead of clobbering. Ignores re-entrant calls for the same noteId
   * while a mutation is already in flight rather than racing it.
   */
  const toggleBookmark = useCallback(
    async (noteId: string) => {
      if (inFlightNoteIds.current.has(noteId)) {
        return;
      }
      inFlightNoteIds.current.add(noteId);
      try {
        const live = bookmarksResource.peek().data ?? EMPTY_DOC;
        const existing = live.bookmarks.find((b) => b.note_id === noteId);

        if (existing) {
          try {
            await bookmarksResource.mutate({
              optimistic: (cur) => ({
                ...(cur ?? EMPTY_DOC),
                bookmarks: (cur ?? EMPTY_DOC).bookmarks.filter(
                  (b) => b.id !== existing.id,
                ),
              }),
              request: () => deleteBookmark(existing.id),
              rollback: (prev) => prev ?? EMPTY_DOC,
            });
          } catch (e) {
            toast({
              title: "Couldn't remove bookmark",
              description: String(e instanceof Error ? e.message : e),
              variant: "error",
            });
          }
          return;
        }

        const optimisticId = `pending-${noteId}`;
        const optimistic: Bookmark = {
          id: optimisticId,
          note_id: noteId,
          folder_id: null,
          order: live.bookmarks.length,
        };
        try {
          await bookmarksResource.mutate({
            optimistic: (cur) => ({
              ...(cur ?? EMPTY_DOC),
              bookmarks: [...(cur ?? EMPTY_DOC).bookmarks, optimistic],
            }),
            request: () => postBookmark(noteId),
            // Reconciled against the LIVE cache at success time — a
            // concurrent WS update or a sibling toggleBookmark call
            // could have landed while the request was in flight.
            commit: (liveAtSuccess, created) => {
              const base = liveAtSuccess ?? EMPTY_DOC;
              return {
                ...base,
                bookmarks: [
                  ...base.bookmarks.filter((b) => b.id !== optimisticId),
                  created,
                ],
              };
            },
            rollback: (prev) => prev ?? EMPTY_DOC,
          });
        } catch (e) {
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
    [toast],
  );

  const moveToFolder = useCallback(
    async (id: string, folderId: string | null) => {
      try {
        await postBookmarkMove(id, folderId);
        await bookmarksResource.invalidate();
      } catch (e) {
        toast({
          title: "Couldn't move bookmark",
          description: String(e instanceof Error ? e.message : e),
          variant: "error",
        });
      }
    },
    [toast],
  );

  // A name clash is rethrown rather than toasted: the inline input renders it
  // beside the field and keeps the typed text so the user can correct it.
  const createFolder = useCallback(
    async (name: string) => {
      try {
        await postBookmarkFolder(name);
        await bookmarksResource.invalidate();
      } catch (e) {
        if (e instanceof BookmarkFolderNameConflictError) {
          throw e;
        }
        toast({
          title: "Couldn't create folder",
          description: String(e instanceof Error ? e.message : e),
          variant: "error",
        });
      }
    },
    [toast],
  );

  /**
   * reorder — optimistically reassigns Order = index (within orderedIds)
   * for exactly the bookmarks named in orderedIds, leaving every bookmark
   * OUTSIDE that scope untouched (mirrors the backend's per-folder Order
   * semantics). Reverts to the pre-mutation snapshot and toasts on
   * failure — same shape as toggleBookmark's optimistic-mutate-then-revert.
   */
  const reorder = useCallback(
    async (folderId: string | null, orderedIds: string[]) => {
      const orderIndex = new Map(orderedIds.map((id, index) => [id, index]));
      try {
        await bookmarksResource.mutate({
          optimistic: (cur) => {
            const base = cur ?? EMPTY_DOC;
            return {
              ...base,
              bookmarks: base.bookmarks.map((b) => {
                const index = orderIndex.get(b.id);
                return index === undefined ? b : { ...b, order: index };
              }),
            };
          },
          request: () => reorderBookmarks(folderId, orderedIds),
          rollback: (prev) => prev ?? EMPTY_DOC,
        });
        await bookmarksResource.invalidate();
      } catch (e) {
        toast({
          title: "Couldn't reorder bookmarks",
          description: String(e instanceof Error ? e.message : e),
          variant: "error",
        });
      }
    },
    [toast],
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
  getSubscriberCount: () => resourcesTesting.getSubscriberCount("bookmarks"),
  simulateEvent: () => publish("bookmark:changed"),
};
