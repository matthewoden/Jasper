/**
 * useDailyNote — opens today's daily note in the editor.
 *
 * Re-entrancy guard: concurrent rapid clicks no-op on the second call.
 * Calls broadcastRefresh() after success so the sidebar tree reflects any
 * newly-created daily note (an H1-rename can move a daily note to a new path,
 * and the next Today click must create a fresh one — the tree must update).
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
  }, [setDailyNoteLoading, setActiveNote, toast]);

  return { openToday, isLoading: dailyNoteLoading };
}
