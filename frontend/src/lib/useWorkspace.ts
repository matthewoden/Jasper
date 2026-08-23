/**
 * useWorkspace projects the shared workspaceResource into the notesSort /
 * searchSort / rightPanel slices and composes them with PUT calls. Mounting
 * issues no request by itself.
 *
 * Writes are optimistic and deliberately NOT debounced — one PUT per selection,
 * reverting and toasting on failure.
 *
 * These stay zustand slices rather than living in the cache because components
 * read them through store selectors; this hook is the only place that projects
 * one into the other.
 */

import { useCallback, useEffect } from "react";
import { useToast } from "../components/toast.utils";
import {
  useTreeStore,
  type NotesSortOrder,
  type SearchSortOrder,
  type RightPanelTab,
  type BookmarksSortOrder,
} from "./useTreeStore";
import { workspaceResource, putWorkspace } from "./workspaceApi";
import { publish, useResource } from "./resources";
import { __testing__ as resourcesTesting } from "./resources/createResource";

export type { RightPanelTab };

export interface UseWorkspaceResult {
  notesSort: NotesSortOrder;
  searchSort: SearchSortOrder;
  rightPanel: RightPanelTab;
  bookmarksSort: BookmarksSortOrder;
  setNotesSort: (value: NotesSortOrder) => Promise<void>;
  setSearchSort: (value: SearchSortOrder) => Promise<void>;
  setRightPanel: (value: RightPanelTab) => Promise<void>;
  setBookmarksSort: (value: BookmarksSortOrder) => Promise<void>;
}

export function useWorkspace(): UseWorkspaceResult {
  const snapshot = useResource(workspaceResource);
  const notesSort = useTreeStore((s) => s.notesSort);
  const setNotesSortSlice = useTreeStore((s) => s.setNotesSort);
  const searchSort = useTreeStore((s) => s.searchSort);
  const setSearchSortSlice = useTreeStore((s) => s.setSearchSort);
  const rightPanel = useTreeStore((s) => s.rightPanel);
  const setRightPanelSlice = useTreeStore((s) => s.setRightPanel);
  const bookmarksSort = useTreeStore((s) => s.bookmarksSort);
  const setBookmarksSortSlice = useTreeStore((s) => s.setBookmarksSort);
  const { toast } = useToast();

  // Projects the shared cache snapshot INTO the existing UI slices — no
  // network call of its own (that's workspaceResource's job, triggered by
  // useResource's subscribe). Keyed on snapshot.data identity, so N
  // mounted instances each run this once per actual cache change, not
  // once per render. Empty string means "use the default" — the
  // store already carries the correct default, so only overwrite on a
  // real value.
  useEffect(() => {
    const doc = snapshot.data;
    if (!doc) return;
    if (doc.notesSort) {
      setNotesSortSlice(doc.notesSort as NotesSortOrder);
    }
    if (doc.searchSort) {
      setSearchSortSlice(doc.searchSort as SearchSortOrder);
    }
    if (doc.rightPanel) {
      setRightPanelSlice(doc.rightPanel as RightPanelTab);
    }
    if (doc.bookmarksSort) {
      setBookmarksSortSlice(doc.bookmarksSort as BookmarksSortOrder);
    }
  }, [
    snapshot.data,
    setNotesSortSlice,
    setSearchSortSlice,
    setRightPanelSlice,
    setBookmarksSortSlice,
  ]);

  const setNotesSort = useCallback(
    async (value: NotesSortOrder) => {
      const previous = useTreeStore.getState().notesSort;
      setNotesSortSlice(value);
      try {
        await putWorkspace({ notesSort: value });
        workspaceResource.patch((cur) => ({ ...cur, notesSort: value }));
      } catch (e) {
        setNotesSortSlice(previous);
        toast({
          title: "Couldn't save sort order. Try again.",
          description: String(e instanceof Error ? e.message : e),
          variant: "error",
        });
      }
    },
    [setNotesSortSlice, toast],
  );

  const setSearchSort = useCallback(
    async (value: SearchSortOrder) => {
      const previous = useTreeStore.getState().searchSort;
      setSearchSortSlice(value);
      try {
        await putWorkspace({ searchSort: value });
        workspaceResource.patch((cur) => ({ ...cur, searchSort: value }));
      } catch (e) {
        setSearchSortSlice(previous);
        toast({
          title: "Couldn't save sort order. Try again.",
          description: String(e instanceof Error ? e.message : e),
          variant: "error",
        });
      }
    },
    [setSearchSortSlice, toast],
  );

  const setRightPanel = useCallback(
    async (value: RightPanelTab) => {
      const previous = useTreeStore.getState().rightPanel;
      setRightPanelSlice(value);
      try {
        await putWorkspace({ rightPanel: value });
        workspaceResource.patch((cur) => ({ ...cur, rightPanel: value }));
      } catch (e) {
        setRightPanelSlice(previous);
        toast({
          title: "Couldn't save panel selection. Try again.",
          description: String(e instanceof Error ? e.message : e),
          variant: "error",
        });
      }
    },
    [setRightPanelSlice, toast],
  );

  const setBookmarksSort = useCallback(
    async (value: BookmarksSortOrder) => {
      const previous = useTreeStore.getState().bookmarksSort;
      setBookmarksSortSlice(value);
      try {
        await putWorkspace({ bookmarksSort: value });
        workspaceResource.patch((cur) => ({ ...cur, bookmarksSort: value }));
      } catch (e) {
        setBookmarksSortSlice(previous);
        toast({
          title: "Couldn't save sort order. Try again.",
          description: String(e instanceof Error ? e.message : e),
          variant: "error",
        });
      }
    },
    [setBookmarksSortSlice, toast],
  );

  return {
    notesSort,
    searchSort,
    rightPanel,
    bookmarksSort,
    setNotesSort,
    setSearchSort,
    setRightPanel,
    setBookmarksSort,
  };
}

export const __testing__ = {
  getSubscriberCount: () => resourcesTesting.getSubscriberCount("workspace"),
  simulateEvent: () => publish("workspace:changed"),
};
