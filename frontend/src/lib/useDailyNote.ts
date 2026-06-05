/**
 * useDailyNote — hook that opens today's daily note in the editor.
 *
 * Wraps openTodayDailyNote() from dailyNoteApi with:
 *   - Re-entrancy guard (T-7-26: concurrent rapid clicks → no-op on second)
 *   - dailyNoteLoading slice in useTreeStore (shared with SidebarToolbar)
 *   - Error toast on failure ("Couldn't open today's daily note")
 *   - activeNote set on success via useTreeStore.setActiveNote
 *   - broadcastRefresh() after success so the sidebar tree reflects any newly-created
 *     daily note (UAT-2 R1-1 fix: after an H1-rename moves the daily note to a new path,
 *     the next Today click creates a fresh daily note — the tree must refresh to show it).
 *
 * Returns { openToday, isLoading } for SidebarToolbar's Today button.
 */

import { useCallback } from "react";
import { useTreeStore } from "./useTreeStore";
import { openTodayDailyNote } from "./dailyNoteApi";
import { broadcastRefresh } from "./useFileTree";
import { useToast } from "../components/toast.utils";

export function useDailyNote() {
  const dailyNoteLoading = useTreeStore((s) => s.dailyNoteLoading);
  const setDailyNoteLoading = useTreeStore((s) => s.setDailyNoteLoading);
  const setActiveNote = useTreeStore((s) => s.setActiveNote);
  const { toast } = useToast();

  const openToday = useCallback(async () => {
    if (dailyNoteLoading) return;

    const today = new Date().toISOString().slice(0, 10);

    setDailyNoteLoading(true);
    try {
      const note = await openTodayDailyNote(today);
      setActiveNote(note.id);
      await broadcastRefresh();
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
