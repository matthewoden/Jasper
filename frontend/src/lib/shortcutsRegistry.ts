// shortcutsRegistry.ts — single source of truth for keyboard shortcuts (D-21, D-15, D-50).
// Powers both the Cmd+P command palette (Plan 07-11) and the Cmd+/ cheat-sheet
// dialog (Plan 07-12). Per UI-SPEC §Forward-Compat #2, NEVER re-implement shortcut
// glyph rendering — import from this file.

export type ShortcutGroup = "File" | "Editor" | "Navigation" | "View" | "Index" | "Help";

export interface Shortcut {
  /** Stable identifier; commands wire actions by id (Plan 07-11). */
  id: string;
  /** User-visible label. MUST match UI-SPEC §Command Registry table strings exactly. */
  label: string;
  /** Group used by both palette grouping and cheat-sheet sectioning. */
  group: ShortcutGroup;
  /** Display string for the shortcut, e.g., "⌘O", "⌘⇧D". Empty if no shortcut. */
  shortcut?: string;
  /** Whether this entry appears in the Cmd+P command palette. */
  inPalette: boolean;
  /** Whether this entry appears in the Cmd+/ cheat-sheet (most do; CM6 built-ins
   *  appear here but NOT in the palette). */
  inCheatSheet: boolean;
}

// Platform detection (D-50) — once at module load.
export const isMac =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
export const mod = isMac ? "⌘" : "Ctrl ";
export const shift = isMac ? "⇧" : "Shift ";

/**
 * SHORTCUTS_REGISTRY — locked v1 entries per UI-SPEC §Command Registry +
 * §Cheat-sheet rows. The label strings are the contract — checker greps for them.
 */
export const SHORTCUTS_REGISTRY: Shortcut[] = [
  // File group
  {
    id: "new-note",
    label: "New note",
    group: "File",
    shortcut: `${mod}N`,
    inPalette: true,
    inCheatSheet: true,
  },
  {
    id: "save",
    label: "Save",
    group: "File",
    shortcut: `${mod}S`,
    inPalette: true,
    inCheatSheet: true,
  },
  // Editor group
  // Note: "Find in note" (Cmd+F) removed in Plan 07-27 — browser native Cmd+F fires instead.
  {
    id: "bold",
    label: "Bold",
    group: "Editor",
    shortcut: `${mod}B`,
    inPalette: false,
    inCheatSheet: true,
  },
  {
    id: "italic",
    label: "Italic",
    group: "Editor",
    shortcut: `${mod}I`,
    inPalette: false,
    inCheatSheet: true,
  },
  // Plan 07-36 (UAT-3 N7): underline removed — markdown editor cannot render HTML inline so <u> tags are invisible.
  {
    id: "frontmatter",
    label: "Toggle raw frontmatter view",
    group: "Editor",
    shortcut: `${mod}${shift}Y`,
    inPalette: false,
    inCheatSheet: true,
  },
  // Navigation group
  {
    id: "today",
    label: "Today",
    group: "Navigation",
    shortcut: `${mod}${shift}D`,
    inPalette: true,
    inCheatSheet: true,
  },
  {
    id: "switch-note",
    label: "Switch / search notes",
    group: "Navigation",
    shortcut: `${mod}O`,
    inPalette: true,
    inCheatSheet: true,
  },
  {
    id: "command-palette",
    label: "Open command palette",
    group: "Navigation",
    shortcut: `${mod}P`,
    inPalette: false,
    inCheatSheet: true,
  },
  // View group
  {
    id: "toggle-theme",
    label: "Toggle theme",
    group: "View",
    inPalette: true,
    inCheatSheet: true,
  },
  // Index group
  {
    id: "refresh-index",
    label: "Refresh index",
    group: "Index",
    inPalette: true,
    inCheatSheet: false,
  },
  {
    id: "rebuild-index",
    label: "Reset and rebuild…",
    group: "Index",
    inPalette: true,
    inCheatSheet: false,
  },
  // Help group
  {
    id: "show-shortcuts",
    label: "Show keyboard shortcuts",
    group: "Help",
    shortcut: `${mod}/`,
    inPalette: true,
    inCheatSheet: true,
  },
];

export const COMMAND_PALETTE_ENTRIES = SHORTCUTS_REGISTRY.filter((s) => s.inPalette);
export const CHEAT_SHEET_ENTRIES = SHORTCUTS_REGISTRY.filter((s) => s.inCheatSheet);

/** Group order used by both palette + cheat-sheet (UI-SPEC §Group order). */
export const GROUP_ORDER: ShortcutGroup[] = [
  "File",
  "Editor",
  "Navigation",
  "View",
  "Index",
  "Help",
];
