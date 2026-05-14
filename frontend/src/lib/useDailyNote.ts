/**
 * useDailyNote — hook that opens today's daily note in the editor.
 *
 * Wraps openTodayDailyNote() from dailyNoteApi with:
 *   - Re-entrancy guard (T-7-26: concurrent rapid clicks → no-op on second)
 *   - dailyNoteLoading slice in useTreeStore (shared with SidebarToolbar)
 *   - Error toast on failure ("Couldn't open today's daily note")
 *   - activeNote set on success via useTreeStore.setActiveNote
 *
 * Returns { openToday, isLoading } for SidebarToolbar's Today button.
 */

import { useCallback } from "react";
import { useTreeStore } from "./useTreeStore";
import { openTodayDailyNote } from "./dailyNoteApi";
import { useToast } from "../components/Toast";

export function useDailyNote() {
  const dailyNoteLoading = useTreeStore((s) => s.dailyNoteLoading);
  const setDailyNoteLoading = useTreeStore((s) => s.setDailyNoteLoading);
  const setActiveNote = useTreeStore((s) => s.setActiveNote);
  const { toast } = useToast();

  const openToday = useCallback(async () => {
    // T-7-26: re-entrancy guard — ignore second click while in flight.
    if (dailyNoteLoading) return;

    // Compute today's date as YYYY-MM-DD at call time (not at module load),
    // so midnight rollovers produce the correct date.
    const today = new Date().toISOString().slice(0, 10);

    setDailyNoteLoading(true);
    try {
      const note = await openTodayDailyNote(today);
      setActiveNote(note.id);
    } catch {
      toast({
        title: "Couldn't open today's daily note",
        description: "Try again, or check the server is running.",
        variant: "error",
      });
    } finally {
      setDailyNoteLoading(false);
    }
  }, [dailyNoteLoading, setDailyNoteLoading, setActiveNote, toast]);

  return { openToday, isLoading: dailyNoteLoading };
}
