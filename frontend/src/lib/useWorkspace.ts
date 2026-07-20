/**
 * useWorkspace — composes the notesSort/searchSort store slices with
 * GET/PUT /vault/workspace calls and a WS refresh subscription on
 * `workspace:changed`. Mirrors useBookmarks.ts's hydrate + subscriber-bus +
 * optimistic-mutate shape (D-12).
 *
 * Public surface:
 *   - notesSort / searchSort: current store slices (hydrated from the
 *                              backend, never localStorage — D-09)
 *   - setNotesSort(value):    optimistic write, NO debounce (D-12) — one
 *                              PUT per selection. Reverts + toasts on failure.
 *   - setSearchSort(value):   same shape as setNotesSort, other field.
 *
 * dispatchWorkspaceEvent() is called by useSessionSync when a
 * `workspace:changed` WS event arrives (origin-filtered server-side), so a
 * second browser session re-fetches and re-sorts live.
 */

import { useCallback, useEffect, useRef } from "react";
import { useToast } from "../components/toast.utils";
import {
  useTreeStore,
  type NotesSortOrder,
  type SearchSortOrder,
} from "./useTreeStore";
import { getWorkspace, putWorkspace } from "./workspaceApi";

const workspaceSubscribers = new Set<() => void>();

/**
 * Called by useSessionSync when a `workspace:changed` WS event arrives.
 * Iterates a snapshot of the subscriber set so mid-iteration
 * register/unregister doesn't cause a concurrent-mutation error.
 */
export function dispatchWorkspaceEvent(): void {
  const snapshot = Array.from(workspaceSubscribers);
  for (const fn of snapshot) fn();
}

export interface UseWorkspaceResult {
  notesSort: NotesSortOrder;
  searchSort: SearchSortOrder;
  setNotesSort: (value: NotesSortOrder) => Promise<void>;
  setSearchSort: (value: SearchSortOrder) => Promise<void>;
}

export function useWorkspace(): UseWorkspaceResult {
  const notesSort = useTreeStore((s) => s.notesSort);
  const setNotesSortSlice = useTreeStore((s) => s.setNotesSort);
  const searchSort = useTreeStore((s) => s.searchSort);
  const setSearchSortSlice = useTreeStore((s) => s.setSearchSort);
  const { toast } = useToast();
  // True once the first hydrate has run. Not currently branched on, but
  // kept for parity with useBookmarks.ts's hydratedRef shape and as a
  // seam for future loading/error UI without another refactor.
  const hydratedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const doc = await getWorkspace();
      // Empty string means "use the default" (D-06) — the store already
      // carries the correct default, so only overwrite on a real value.
      if (doc.notesSort) {
        setNotesSortSlice(doc.notesSort as NotesSortOrder);
      }
      if (doc.searchSort) {
        setSearchSortSlice(doc.searchSort as SearchSortOrder);
      }
      hydratedRef.current = true;
    } catch {
      // Swallow — keep whatever default/last-known-good slice is in
      // place rather than surfacing an error for a background refresh.
    }
  }, [setNotesSortSlice, setSearchSortSlice]);

  useEffect(() => {
    void refresh();
    workspaceSubscribers.add(refresh);
    return () => {
      workspaceSubscribers.delete(refresh);
    };
  }, [refresh]);

  const setNotesSort = useCallback(
    async (value: NotesSortOrder) => {
      const previous = useTreeStore.getState().notesSort;
      setNotesSortSlice(value);
      try {
        await putWorkspace({ notesSort: value });
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

  return { notesSort, searchSort, setNotesSort, setSearchSort };
}

export const __testing__ = {
  getSubscriberCount: () => workspaceSubscribers.size,
  simulateEvent: () => dispatchWorkspaceEvent(),
};
