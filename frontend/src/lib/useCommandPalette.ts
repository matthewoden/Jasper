/**
 * useCommandPalette — filters COMMAND_PALETTE_ENTRIES by label substring
 * and dispatches execute(id) to the appropriate action callback.
 *
 * Actions are passed in at hook construction time (called from a parent
 * component that has all necessary dependencies wired — Plan 07-12 / App.tsx).
 * The hook only handles lookup + dispatch (D-47: synchronous, no inline confirmations).
 *
 * Per the plan decision: use label substring match (case-insensitive), preserving
 * the group order from GROUP_ORDER for grouping in the UI.
 */
import { useCallback, useMemo } from "react";
import { COMMAND_PALETTE_ENTRIES, type Shortcut } from "./shortcutsRegistry";

export interface CommandActions {
  onNewNote?: () => void;
  onSave?: () => void;
  onFind?: () => void;
  onToday?: () => void;
  onSwitchNote?: () => void;
  onToggleTheme?: () => void;
  onRefreshIndex?: () => void;
  onRebuildIndex?: () => void;
  onShowShortcuts?: () => void;
}

/**
 * Commands that should NOT close the palette when executed.
 * UAT #5 fix: "Switch note…" flips palette mode in place; closing then
 * trying to re-render the new mode loses the modal context.
 */
const COMMANDS_KEEP_OPEN: ReadonlySet<string> = new Set(["switch-note"]);

export interface CommandPaletteResult {
  /** Returns all palette entries (empty query) or filtered by label substring. */
  filtered: (query: string) => Shortcut[];
  /**
   * Dispatches the action for the given command id. Returns true if the
   * caller should close the palette after this command, false if it should
   * stay open (e.g., switch-note re-renders in notes mode).
   * No-ops (but still returns true) if id unknown or action not provided.
   */
  execute: (id: string) => boolean;
}

export function useCommandPalette(actions: CommandActions): CommandPaletteResult {
  // Build id → action lookup table; re-derived when actions reference changes.
  const idToAction: Record<string, (() => void) | undefined> = useMemo(
    () => ({
      "new-note": actions.onNewNote,
      "save": actions.onSave,
      "find": actions.onFind,
      "today": actions.onToday,
      "switch-note": actions.onSwitchNote,
      "toggle-theme": actions.onToggleTheme,
      "refresh-index": actions.onRefreshIndex,
      "rebuild-index": actions.onRebuildIndex,
      "show-shortcuts": actions.onShowShortcuts,
    }),
    [
      actions.onNewNote,
      actions.onSave,
      actions.onFind,
      actions.onToday,
      actions.onSwitchNote,
      actions.onToggleTheme,
      actions.onRefreshIndex,
      actions.onRebuildIndex,
      actions.onShowShortcuts,
    ],
  );

  const filtered = useCallback((query: string): Shortcut[] => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMAND_PALETTE_ENTRIES;
    return COMMAND_PALETTE_ENTRIES.filter((e) =>
      e.label.toLowerCase().includes(q),
    );
  }, []);

  const execute = useCallback(
    (id: string): boolean => {
      const fn = idToAction[id];
      if (fn) fn();
      // Return true (close palette) for all commands EXCEPT those in COMMANDS_KEEP_OPEN.
      return !COMMANDS_KEEP_OPEN.has(id);
    },
    [idToAction],
  );

  return { filtered, execute };
}
