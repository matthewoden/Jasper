/**
 * useDailyNote opens today's daily note, with a re-entrancy guard so rapid
 * clicks no-op.
 *
 * The tree refresh is best-effort and OUTSIDE the open-failure boundary: once
 * the note has opened, a refresh rejection must not retroactively report the
 * open as failed.
 *
 * Folder expansion happens AFTER that refresh settles. A coalesced in-flight
 * response can resolve against a snapshot taken before the folder existed, and
 * a successful fetch prunes expanded paths it does not contain — so expanding
 * first drops the expansion.
 */

import { useCallback } from "react";
import { useTreeStore } from "./useTreeStore";
import { usePaneStore } from "./usePaneStore";
import { openTodayDailyNote } from "./dailyNoteApi";
import { broadcastRefresh } from "./useFileTree";
import { expandNoteAncestorFolders } from "../components/fileTree.utils";
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

    let openedPath: string | null = null;
    setDailyNoteLoading(true);
    try {
      const note = await openTodayDailyNote(today);
      setActiveNote(note.id);
      // Opens as a tab in the active pane via the openInActivePane primitive.
      usePaneStore.getState().openInActivePane(note.id);
      openedPath = note.path;
    } catch {
      toast({
        title: "Couldn't open today's daily note",
        description: "Try again, or check the server is running.",
        variant: "error",
      });
      return; // note never opened — nothing to refresh, nothing to expand
    } finally {
      setDailyNoteLoading(false);
    }
    // Tree refresh is now non-fatal AND non-blocking for the open path — a
    // failure here must never retroactively toast "couldn't open".
    await broadcastRefresh().catch(() => {
      // best-effort; sidebar tree will reconcile on next successful refresh
    });
    if (openedPath) {
      expandNoteAncestorFolders(openedPath);
    }
  }, [setDailyNoteLoading, setActiveNote, toast]);

  return { openToday, isLoading: dailyNoteLoading };
}
