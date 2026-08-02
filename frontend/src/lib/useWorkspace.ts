/**
 * useWorkspace — reads the shared `workspaceResource` cache and projects it
 * into the notesSort/searchSort/rightPanel zustand UI slices, then composes
 * those slices with PUT /vault/workspace calls. The GET side is
 * fetch-once-and-cache via the resource layer: mounting
 * never issues a network request by itself; only the resource's own 0->1
 * subscriber transition and `workspace:changed` WS invalidation do.
 *
 * Public surface:
 *   - notesSort / searchSort / rightPanel: current store slices (hydrated
 *                              from the shared cache, never localStorage)
 *   - setNotesSort(value):    optimistic write, NO debounce — one
 *                              PUT per selection. Reverts + toasts on failure.
 *   - setSearchSort(value):   same shape as setNotesSort, other field.
 *   - setRightPanel(value):   same shape as setNotesSort, rightPanel field
 *                              (TAGS-01).
 *
 * Note: notesSort/searchSort/rightPanel remain zustand slices (they're
 * read directly by components through their own store selectors), not the
 * resource cache itself. This hook is the ONLY place that projects the
 * shared cache INTO those slices — see the sync effect below.
 */

import { useCallback, useEffect } from "react";
import { useToast } from "../components/toast.utils";
import {
  useTreeStore,
  type NotesSortOrder,
  type SearchSortOrder,
  type RightPanelTab,
} from "./useTreeStore";
import { workspaceResource, putWorkspace } from "./workspaceApi";
import { publish, useResource } from "./resources";
import { __testing__ as resourcesTesting } from "./resources/createResource";

export type { RightPanelTab };

export interface UseWorkspaceResult {
  notesSort: NotesSortOrder;
  searchSort: SearchSortOrder;
  rightPanel: RightPanelTab;
  setNotesSort: (value: NotesSortOrder) => Promise<void>;
  setSearchSort: (value: SearchSortOrder) => Promise<void>;
  setRightPanel: (value: RightPanelTab) => Promise<void>;
}

export function useWorkspace(): UseWorkspaceResult {
  const snapshot = useResource(workspaceResource);
  const notesSort = useTreeStore((s) => s.notesSort);
  const setNotesSortSlice = useTreeStore((s) => s.setNotesSort);
  const searchSort = useTreeStore((s) => s.searchSort);
  const setSearchSortSlice = useTreeStore((s) => s.setSearchSort);
  const rightPanel = useTreeStore((s) => s.rightPanel);
  const setRightPanelSlice = useTreeStore((s) => s.setRightPanel);
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
  }, [snapshot.data, setNotesSortSlice, setSearchSortSlice, setRightPanelSlice]);

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

  return {
    notesSort,
    searchSort,
    rightPanel,
    setNotesSort,
    setSearchSort,
    setRightPanel,
  };
}

export const __testing__ = {
  getSubscriberCount: () => resourcesTesting.getSubscriberCount("workspace"),
  simulateEvent: () => publish("workspace:changed"),
};
