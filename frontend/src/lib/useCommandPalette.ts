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

// Module-level constant — never changes across renders, so it doesn't
// belong in any useCallback / useMemo dep array. Plan 08-06: a command
// is "disabled" (rendered dimmed) when the lookup table has no bound
// action for its id. We restrict disabled-rendering to commands that
// explicitly opt in to that affordance — current set: just
// share-reveal-current-note. Existing commands (new-note / save /
// today / ...) are always present whenever the palette opens, so an
// undefined fn means "not wired" and we still gracefully no-op
// execute() rather than render them dimmed.
const DISABLEABLE_IDS: ReadonlySet<string> = new Set([
  "share-reveal-current-note",
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
  // Plan 08-06 (D-26 / SHARE-01 Mount C): opens the host OS file manager
  // focused on the currently active note. The caller is expected to
  // resolve the active note's path before invoking; if no note is active,
  // the caller passes undefined so the palette renders the entry dimmed.
  onShareRevealCurrentNote?: () => void;
  // Plan 08-17c (V7): opens the VaultPicker in switch mode.
  // No hotkey (Cmd-Shift-V dropped per V7 — Chrome paste collision).
  onSwitchVault?: () => void;
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
  /**
   * Plan 08-06 (D-26 / SHARE-01 Mount C): true when the command's
   * underlying action is unavailable (e.g. "Show current note in file
   * manager" with no note active). Palette uses this to render the row
   * dimmed-and-inert without filtering it out.
   */
  isDisabled: (id: string) => boolean;
}

export function useCommandPalette(actions: CommandActions): CommandPaletteResult {
  // Build id → action lookup table; re-derived when actions reference changes.
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
      // Plan 08-06: undefined when no note is active (palette renders dimmed).
      "share-reveal-current-note": actions.onShareRevealCurrentNote,
      // Plan 08-17c (V7): opens the VaultPicker in switch mode.
      "vault.switch": actions.onSwitchVault,
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

  // DISABLEABLE_IDS lives at module scope — see the const at the top.
  const isDisabled = useCallback(
    (id: string): boolean => DISABLEABLE_IDS.has(id) && !idToAction[id],
    [idToAction],
  );

  return { filtered, execute, isDisabled };
}
