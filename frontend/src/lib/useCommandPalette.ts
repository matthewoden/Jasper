/**
 * useCommandPalette — filters COMMAND_PALETTE_ENTRIES by label substring
 * and dispatches execute(id) to the appropriate action callback.
 *
 * Actions are passed in at hook construction time from the parent component
 * that has all required dependencies wired. Filter is case-insensitive
 * substring match; group order from GROUP_ORDER is preserved.
 */
import { useCallback, useMemo } from "react";
import { COMMAND_PALETTE_ENTRIES, type Shortcut } from "./shortcutsRegistry";


const DISABLEABLE_IDS: ReadonlySet<string> = new Set([
  "share-reveal-current-note",
  "bookmark.toggle",
]);

export interface CommandActions {
  onNewNote?: () => void;
  onSave?: () => void;
  onToday?: () => void;
  onSwitchNote?: () => void;
  onToggleTheme?: () => void;
  onRefreshIndex?: () => void;
  onRebuildIndex?: () => void;
  onShowShortcuts?: () => void;
  onShareRevealCurrentNote?: () => void;
  onSwitchVault?: () => void;
  onToggleZen?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onFocusNextPane?: () => void;
  onFocusPrevPane?: () => void;
  onToggleSidebar?: () => void;
  onBookmarkCurrent?: () => void;
}

/**
 * Commands that should NOT close the palette when executed.
 * "Switch note…" flips palette mode in place; closing before the new mode
 * renders would lose the modal context.
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
  /**
   * True when the command's underlying action is unavailable (e.g. "Show
   * current note in file manager" with no note active). Palette renders the
   * row dimmed-and-inert rather than filtering it out.
   */
  isDisabled: (id: string) => boolean;
}

export function useCommandPalette(actions: CommandActions): CommandPaletteResult {
  const idToAction: Record<string, (() => void) | undefined> = useMemo(
    () => ({
      "new-note": actions.onNewNote,
      "save": actions.onSave,
      "today": actions.onToday,
      "switch-note": actions.onSwitchNote,
      "toggle-theme": actions.onToggleTheme,
      "refresh-index": actions.onRefreshIndex,
      "rebuild-index": actions.onRebuildIndex,
      "show-shortcuts": actions.onShowShortcuts,
      "share-reveal-current-note": actions.onShareRevealCurrentNote,
      "vault.switch": actions.onSwitchVault,
      "zen.toggle": actions.onToggleZen,
      "split-right": actions.onSplitRight,
      "split-down": actions.onSplitDown,
      "focus-next-pane": actions.onFocusNextPane,
      "focus-previous-pane": actions.onFocusPrevPane,
      "sidebar.toggle": actions.onToggleSidebar,
      "bookmark.toggle": actions.onBookmarkCurrent,
    }),
    [
      actions.onNewNote,
      actions.onSave,
      actions.onToday,
      actions.onSwitchNote,
      actions.onToggleTheme,
      actions.onRefreshIndex,
      actions.onRebuildIndex,
      actions.onShowShortcuts,
      actions.onShareRevealCurrentNote,
      actions.onSwitchVault,
      actions.onToggleZen,
      actions.onSplitRight,
      actions.onSplitDown,
      actions.onFocusNextPane,
      actions.onFocusPrevPane,
      actions.onToggleSidebar,
      actions.onBookmarkCurrent,
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
      return !COMMANDS_KEEP_OPEN.has(id);
    },
    [idToAction],
  );

  const isDisabled = useCallback(
    (id: string): boolean => DISABLEABLE_IDS.has(id) && !idToAction[id],
    [idToAction],
  );

  return { filtered, execute, isDisabled };
}
