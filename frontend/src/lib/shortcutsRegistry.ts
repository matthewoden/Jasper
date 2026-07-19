


export type ShortcutGroup =
  | "File"
  | "Editor"
  | "Navigation"
  | "Sidebar"
  | "Palette"
  | "View"
  | "Pane"
  | "Share"
  | "Index"
  | "Help"
  | "Vault";

export interface Shortcut {
  /** Stable identifier; commands wire actions by id. */
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


export const isMac =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
export const mod = isMac ? "⌘" : "Ctrl ";
export const shift = isMac ? "⇧" : "Shift ";

/** SHORTCUTS_REGISTRY — all palette and cheat-sheet entries. Label strings are the contract. */
export const SHORTCUTS_REGISTRY: Shortcut[] = [
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
  {
    id: "frontmatter",
    label: "Toggle raw frontmatter view",
    group: "Editor",
    shortcut: `${mod}${shift}Y`,
    inPalette: false,
    inCheatSheet: true,
  },
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
  {
    id: "tab-close",
    label: "Close tab",
    group: "Navigation",
    shortcut: "⌥W",
    inPalette: false,
    inCheatSheet: true,
  },
  {
    id: "tab-next",
    label: "Next tab",
    group: "Navigation",
    shortcut: "⌥]",
    inPalette: false,
    inCheatSheet: true,
  },
  {
    id: "tab-prev",
    label: "Previous tab",
    group: "Navigation",
    shortcut: "⌥[",
    inPalette: false,
    inCheatSheet: true,
  },
  {
    id: "tab-new",
    label: "New tab",
    group: "Navigation",
    shortcut: "⌥T",
    inPalette: false,
    inCheatSheet: true,
  },
  {
    id: "focus-search",
    label: "Search notes",
    group: "Palette",
    shortcut: `${mod}${shift}F`,
    inPalette: false,
    inCheatSheet: true,
  },
  {
    id: "toggle-theme",
    label: "Toggle theme",
    group: "View",
    inPalette: true,
    inCheatSheet: true,
  },
  {
    id: "vault.switch",
    label: "Switch vault…",
    group: "Vault",
    inPalette: true,
    inCheatSheet: false,
  },
  {
    id: "zen.toggle",
    label: "Toggle Zen Mode",
    group: "View",
    shortcut: `${mod}.`,
    inPalette: true,
    inCheatSheet: true,
  },
  {
    id: "share-reveal-current-note",
    label: "Show current note in file manager",
    group: "Share",
    inPalette: true,
    inCheatSheet: false,
  },
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
  {
    id: "show-shortcuts",
    label: "Show keyboard shortcuts",
    group: "Help",
    shortcut: `${mod}/`,
    inPalette: true,
    inCheatSheet: true,
  },
  {
    id: "split-right",
    label: "Split right",
    group: "Pane",
    shortcut: `${mod}\\`,
    inPalette: true,
    inCheatSheet: true,
  },
  {
    id: "split-down",
    label: "Split down",
    group: "Pane",
    shortcut: `${mod}${shift}\\`,
    inPalette: true,
    inCheatSheet: true,
  },
  {
    id: "focus-next-pane",
    label: "Focus next pane",
    group: "Pane",
    shortcut: `${mod}⌥→`,
    inPalette: true,
    inCheatSheet: true,
  },
  {
    id: "focus-previous-pane",
    label: "Focus previous pane",
    group: "Pane",
    shortcut: `${mod}⌥←`,
    inPalette: true,
    inCheatSheet: true,
  },
  {
    id: "sidebar.toggle",
    label: "Toggle left sidebar",
    group: "Sidebar",
    shortcut: `${mod}${shift}E`,
    inPalette: true,
    inCheatSheet: true,
  },
  {
    id: "bookmark.toggle",
    label: "Bookmark current note",
    group: "Sidebar",
    shortcut: `${mod}${shift}B`,
    inPalette: true,
    inCheatSheet: true,
  },
];

export const COMMAND_PALETTE_ENTRIES = SHORTCUTS_REGISTRY.filter((s) => s.inPalette);
export const CHEAT_SHEET_ENTRIES = SHORTCUTS_REGISTRY.filter((s) => s.inCheatSheet);

/** Group order used by both palette + cheat-sheet. */


export const GROUP_ORDER: ShortcutGroup[] = [
  "File",
  "Editor",
  "Navigation",
  "Sidebar",
  "Palette",
  "View",
  "Pane",
  "Share",
  "Index",
  "Help",
  "Vault",
];
