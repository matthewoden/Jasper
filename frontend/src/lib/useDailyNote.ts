/**
 * useDailyNote — opens today's daily note in the editor.
 *
 * Re-entrancy guard: concurrent rapid clicks no-op on the second call.
 * Calls broadcastRefresh() after success so the sidebar tree reflects any
 * newly-created daily note (an H1-rename can move a daily note to a new path,
 * and the next Today click must create a fresh one — the tree must update).
 * The refresh call sits outside the open-failure boundary and is best-effort
 * (non-fatal): once the note has opened, a refresh rejection never
 * retroactively reports the open itself as failed (WR-04).
 *
 * Returns { openToday, isLoading } for SidebarToolbar's Today button.
 */

import { useCallback } from "react";
import { useTreeStore } from "./useTreeStore";
import { useTabStore } from "./useTabStore";
import { openTodayDailyNote } from "./dailyNoteApi";
import { broadcastRefresh } from "./useFileTree";
import { useToast } from "../components/toast.utils";

export function useDailyNote() {
  const dailyNoteLoading = useTreeStore((s) => s.dailyNoteLoading);
  const setDailyNoteLoading = useTreeStore((s) => s.setDailyNoteLoading);
  const setActiveNote = useTreeStore((s) => s.setActiveNote);
  const { toast } = useToast();

  const openToday = useCallback(async () => {
    if (useTreeStore.getState().dailyNoteLoading) return;

    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    setDailyNoteLoading(true);
    try {
      const note = await openTodayDailyNote(today);
      setActiveNote(note.id);
      useTabStore.getState().openTab(note.id);
    } catch {
      toast({
        title: "Couldn't open today's daily note",
        description: "Try again, or check the server is running.",
        variant: "error",
      });
      return; // note never opened — nothing to refresh
    } finally {
      setDailyNoteLoading(false);
    }
    // Tree refresh is now non-fatal AND non-blocking for the open path — a
    // failure here must never retroactively toast "couldn't open" (WR-04).
    await broadcastRefresh().catch(() => {
      // best-effort; sidebar tree will reconcile on next successful refresh
    });
  }, [setDailyNoteLoading, setActiveNote, toast]);

  return { openToday, isLoading: dailyNoteLoading };
}
