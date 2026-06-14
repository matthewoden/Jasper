/**
 * useTreeStore — zustand store for the file-tree sidebar.
 *
 * Persistent slices (debounced 250ms, tolerates corrupted localStorage):
 *   - localStorage["jasper.tree.expanded"]      JSON Array<string>
 *   - localStorage["jasper.tree.activeNoteId"]  JSON string-or-null
 *
 * Transient slots (never persisted): pendingRename, draftCreate, selectedRow.
 *
 * selectedRow is read by App.tsx's document-level F2 listener to route rename
 * to the right row even after focus has shifted to the editor.
 *
 * pruneStaleTreeState(folderPaths, noteIds) is called by useFileTree after every
 * successful tree fetch to drop expanded entries / activeNoteId that no longer
 * exist. Does not touch transient slots.
 */
import { create } from "zustand";


import type { components } from "../api/schema";
type SearchResult = components["schemas"]["SearchResult"];

export const LS_KEY_EXPANDED = "jasper.tree.expanded";

/** Transient — not persisted. Reconnects on every page load. */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting";
export const LS_KEY_ACTIVE_NOTE = "jasper.tree.activeNoteId";


export const LS_KEY_SIDEBAR_WIDTH = "jasper.sidebar.width";
export const SIDEBAR_WIDTH_DEFAULT = 260;


export const LS_KEY_TAG_BROWSER = "jasper.tag.browser.expanded";
export const LS_KEY_BACKLINKS_RAIL_EXPANDED = "jasper.backlinks.rail.expanded";
export const LS_KEY_BACKLINKS_RAIL_WIDTH = "jasper.backlinks.rail.width";
export const RAIL_DEFAULT_WIDTH = 280;
export const RAIL_MIN_WIDTH = 220;
export const RAIL_MAX_WIDTH = 480;
export const RAIL_COLLAPSED_WIDTH = 32;


export const LS_KEY_TAGS_PANEL_HEIGHT_RATIO = "jasper.rail.tags.height.ratio";
export const LS_KEY_TAGS_PANEL_EXPANDED = "jasper.rail.tags.expanded";


export const LS_KEY_SIDEBAR_VISIBLE = "jasper.chrome.sidebar.visible";
export const LS_KEY_PANEL_TAGS = "jasper.chrome.panel.selector.tags";
export const LS_KEY_PANEL_BACKLINKS = "jasper.chrome.panel.selector.backlinks";


export const LS_KEY_SWITCHER_RECENCY = "jasper:switcher:recency";
export const TAGS_PANEL_RATIO_DEFAULT = 0.5;
export const TAGS_PANEL_RATIO_MIN = 0.2;
export const TAGS_PANEL_RATIO_MAX = 0.8;


const EDITOR_MIN = 320;

export type RenameKind = "note" | "folder" | "file";

export type PendingRename = {
  kind: RenameKind;
  target: string;
  /**
   * True when the rename was triggered by a create action (name never confirmed).
   * Escape / same-name blur should DELETE the node rather than close the input,
   * because leaving the auto-generated placeholder name on disk is surprising.
   * Not set for regular F2 / double-click renames.
   */
  isNew?: boolean;
};
export type DraftCreate = { kind: RenameKind; parent: string };
export type SelectedRow = { kind: RenameKind; target: string };

export interface TreeStore {
  expanded: Set<string>;
  activeNoteId: string | null;

  activeFilePath: string | null;
  setActiveFilePath: (p: string | null) => void;

  pendingRename: PendingRename | null;
  draftCreate: DraftCreate | null;
  selectedRow: SelectedRow | null;

  connectionStatus: ConnectionStatus;

  forceWsReconnect: () => void;
  setForceWsReconnect: (fn: () => void) => void;

  liveLabels: Record<string, string>;
  setLiveLabel: (id: string, label: string) => void;
  clearLiveLabel: (id: string) => void;

  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;

  toggleExpanded: (path: string) => void;
  setActiveNote: (id: string | null) => void;
  /**
   * startRename — enter inline-rename mode for the node at kind + target.
   * Pass isNew: true for a just-created node (see PendingRename.isNew).
   */
  startRename: (kind: RenameKind, target: string, isNew?: boolean) => void;
  endRename: () => void;
  startDraftCreate: (kind: RenameKind, parent: string) => void;
  endDraftCreate: () => void;
  setSelectedRow: (sr: SelectedRow | null) => void;

  setConnectionStatus: (s: ConnectionStatus) => void;

  tagBrowserExpanded: boolean;
  setTagBrowserExpanded: (v: boolean) => void;
  activeTagFilter: string | null;
  setActiveTagFilter: (t: string | null) => void;
  backlinksRailExpanded: boolean;
  setBacklinksRailExpanded: (v: boolean) => void;
  backlinksRailWidth: number;
  setBacklinksRailWidth: (w: number) => void;

  tagsPanelHeightRatio: number;
  setTagsPanelHeightRatio: (r: number) => void;
  rightRailTagsPanelExpanded: boolean;
  setRightRailTagsPanelExpanded: (v: boolean) => void;

  notesSidebarVisible: boolean;
  setNotesSidebarVisible: (v: boolean) => void;
  panelSelector: { tags: boolean; backlinks: boolean };
  setPanelSelector: (update: Partial<{ tags: boolean; backlinks: boolean }>) => void;

  pulseTarget: { kind: "folder" | "note"; target: string } | null;
  setPulseTarget: (t: { kind: "folder" | "note"; target: string } | null) => void;

  searchQuery: string;
  setSearchQuery: (q: string) => void;
  searchResults: SearchResult[];
  setSearchResults: (r: SearchResult[]) => void;
  searchActive: boolean;
  setSearchActive: (v: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  paletteMode: "notes" | "commands" | "search";
  setPaletteMode: (m: "notes" | "commands" | "search") => void;
  recentlyOpenedNoteIds: string[];
  recordOpenedNote: (id: string) => void;
  dailyNoteLoading: boolean;
  setDailyNoteLoading: (v: boolean) => void;
  cheatSheetOpen: boolean;
  setCheatSheetOpen: (v: boolean) => void;

  saveState: import("./saveStateMachine").SaveState;
  setSaveState: (s: import("./saveStateMachine").SaveState) => void;

  mcpGrants: McpGrant[];
  mcpEnabled: boolean;
  setMcpGrants: (grants: McpGrant[]) => void;
  setMcpEnabled: (enabled: boolean) => void;

  vaultPickerOpen: boolean;
  setVaultPickerOpen: (v: boolean) => void;

  vaultSwitching: { active: boolean; targetName: string };
  setVaultSwitching: (s: { active: boolean; targetName: string }) => void;
}


export interface McpGrant {
  folder_path: string;
  level: 1 | 2;
  granted_at: string;
  granted_via: string;
}

export const useTreeStore = create<TreeStore>((set) => ({
  expanded: new Set<string>(),
  activeNoteId: null,
  activeFilePath: null,
  setActiveFilePath: (p) =>
    set(
      p === null
        ? { activeFilePath: null }
        : { activeFilePath: p, activeNoteId: null },
    ),
  pendingRename: null,
  draftCreate: null,
  selectedRow: null,
  connectionStatus: "connecting",
  liveLabels: {},
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  toggleExpanded: (path) =>
    set((s) => {
      const next = new Set(s.expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expanded: next };
    }),
  setActiveNote: (id) => set({ activeNoteId: id }),
  startRename: (kind, target, isNew) =>
    set({ pendingRename: { kind, target, ...(isNew ? { isNew: true } : {}) } }),
  endRename: () => set({ pendingRename: null }),
  startDraftCreate: (kind, parent) => set({ draftCreate: { kind, parent } }),
  endDraftCreate: () => set({ draftCreate: null }),
  setSelectedRow: (sr) => set({ selectedRow: sr }),
  setConnectionStatus: (s) => set({ connectionStatus: s }),
  forceWsReconnect: () => {},
  setForceWsReconnect: (fn) => set({ forceWsReconnect: fn }),
  setLiveLabel: (id, label) =>
    set((s) => ({ liveLabels: { ...s.liveLabels, [id]: label } })),
  clearLiveLabel: (id) =>
    set((s) => {
      if (!(id in s.liveLabels)) return s;
      const rest: Record<string, string> = {};
      for (const k of Object.keys(s.liveLabels)) {
        if (k !== id) rest[k] = s.liveLabels[k];
      }
      return { liveLabels: rest };
    }),
  setSidebarWidth: (w) => {
    const minClamped = Math.max(SIDEBAR_WIDTH_DEFAULT, w);
    if (typeof window === "undefined") {
      set({ sidebarWidth: minClamped });
      return;
    }
    const liveMax = Math.max(0, window.innerWidth - EDITOR_MIN);
    set({ sidebarWidth: Math.min(minClamped, liveMax) });
  },

  tagBrowserExpanded: false,
  setTagBrowserExpanded: (v) => set({ tagBrowserExpanded: v }),
  activeTagFilter: null,
  setActiveTagFilter: (t) => set({ activeTagFilter: t !== null ? t.replace(/^#+/, "") : null }),
  backlinksRailExpanded: false,
  setBacklinksRailExpanded: (v) => set({ backlinksRailExpanded: v }),
  backlinksRailWidth: RAIL_DEFAULT_WIDTH,
  setBacklinksRailWidth: (w) =>
    set({ backlinksRailWidth: Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, w)) }),

  tagsPanelHeightRatio: TAGS_PANEL_RATIO_DEFAULT,
  setTagsPanelHeightRatio: (r) =>
    set({
      tagsPanelHeightRatio: Math.min(
        TAGS_PANEL_RATIO_MAX,
        Math.max(TAGS_PANEL_RATIO_MIN, r),
      ),
    }),
  rightRailTagsPanelExpanded: true,
  setRightRailTagsPanelExpanded: (v) => set({ rightRailTagsPanelExpanded: v }),

  notesSidebarVisible: true,
  setNotesSidebarVisible: (v) => set({ notesSidebarVisible: v }),
  panelSelector: { tags: true, backlinks: true },
  setPanelSelector: (update) =>
    set((s) => ({ panelSelector: { ...s.panelSelector, ...update } })),

  pulseTarget: null,
  setPulseTarget: (t) => set({ pulseTarget: t }),

  searchQuery: "",
  setSearchQuery: (q) => set({ searchQuery: q }),
  searchResults: [],
  setSearchResults: (r) => set({ searchResults: r }),
  searchActive: false,
  setSearchActive: (v) => set({ searchActive: v }),
  paletteOpen: false,
  setPaletteOpen: (v) => set({ paletteOpen: v }),
  paletteMode: "notes",
  setPaletteMode: (m) => set({ paletteMode: m }),
  recentlyOpenedNoteIds: [],
  recordOpenedNote: (id) =>
    set((state) => {
      const filtered = state.recentlyOpenedNoteIds.filter(
        (existingId) => existingId !== id,
      );
      const next = [id, ...filtered].slice(0, 50);
      return { recentlyOpenedNoteIds: next };
    }),
  dailyNoteLoading: false,
  setDailyNoteLoading: (v) => set({ dailyNoteLoading: v }),
  cheatSheetOpen: false,
  setCheatSheetOpen: (v) => set({ cheatSheetOpen: v }),

  saveState: { status: "idle" },
  setSaveState: (s) => set({ saveState: s }),

  mcpGrants: [],
  mcpEnabled: false,
  setMcpGrants: (grants) => set({ mcpGrants: grants }),
  setMcpEnabled: (enabled) => set({ mcpEnabled: enabled }),

  vaultPickerOpen: false,
  setVaultPickerOpen: (v) => set({ vaultPickerOpen: v }),

  vaultSwitching: { active: false, targetName: "" },
  setVaultSwitching: (s) => set({ vaultSwitching: s }),
}));

/**
 * pruneStaleTreeState — drops expanded entries / activeNoteId not present in
 * the freshly-fetched tree. Gated on actual change so a no-op pass preserves
 * reference identity (lets memoized consumers skip re-renders).
 */
export function pruneStaleTreeState(
  allFolderPaths: Set<string>,
  allNoteIds: Set<string>,
): void {
  const s = useTreeStore.getState();
  const cleanExpanded = new Set(
    [...s.expanded].filter((p) => allFolderPaths.has(p)),
  );
  const cleanActive =
    s.activeNoteId && allNoteIds.has(s.activeNoteId) ? s.activeNoteId : null;

  let cleanLabels = s.liveLabels;
  let labelsChanged = false;
  const labelEntries = Object.entries(s.liveLabels);
  const stale = labelEntries.some(([id]) => !allNoteIds.has(id));
  if (stale) {
    cleanLabels = Object.fromEntries(
      labelEntries.filter(([id]) => allNoteIds.has(id)),
    );
    labelsChanged = true;
  }

  const expandedChanged = cleanExpanded.size !== s.expanded.size;
  const activeChanged = cleanActive !== s.activeNoteId;
  if (expandedChanged || activeChanged || labelsChanged) {
    useTreeStore.setState({
      ...(expandedChanged ? { expanded: cleanExpanded } : {}),
      ...(activeChanged ? { activeNoteId: cleanActive } : {}),
      ...(labelsChanged ? { liveLabels: cleanLabels } : {}),
    });
  }
}


if (typeof window !== "undefined") {
  try {
    const raw = window.localStorage.getItem(LS_KEY_EXPANDED);
    if (raw !== null) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const filtered = arr.filter((x): x is string => typeof x === "string");
        useTreeStore.setState({ expanded: new Set(filtered) });
      }
    }
  } catch {
    // Corrupted storage — fall back to default empty Set; do NOT throw.
  }

  try {
    const raw = window.localStorage.getItem(LS_KEY_ACTIVE_NOTE);
    if (raw !== null) {
      const id = JSON.parse(raw);
      if (id === null || typeof id === "string") {
        useTreeStore.setState({ activeNoteId: id });
      }
    }
  } catch {
    // Corrupted storage — fall back to default null; do NOT throw.
  }

  try {
    const raw = window.localStorage.getItem(LS_KEY_SIDEBAR_WIDTH);
    if (raw !== null) {
      const n = JSON.parse(raw);
      if (typeof n === "number" && Number.isFinite(n)) {
        const liveMax = Math.max(0, window.innerWidth - EDITOR_MIN);
        const clamped = Math.min(
          Math.max(SIDEBAR_WIDTH_DEFAULT, n),
          liveMax,
        );
        useTreeStore.setState({ sidebarWidth: clamped });
      }
    }
  } catch {
    // Corrupted storage — fall through to default; do NOT throw.
  }

  try {
    const raw = window.localStorage.getItem(LS_KEY_TAG_BROWSER);
    if (raw === "true") useTreeStore.setState({ tagBrowserExpanded: true });
  } catch {
    // Corrupted storage — fall through to default; do NOT throw.
  }
  try {
    const raw = window.localStorage.getItem(LS_KEY_BACKLINKS_RAIL_EXPANDED);
    if (raw === "true") useTreeStore.setState({ backlinksRailExpanded: true });
  } catch {
    // Corrupted storage — fall through to default; do NOT throw.
  }
  try {
    const raw = window.localStorage.getItem(LS_KEY_BACKLINKS_RAIL_WIDTH);
    if (raw !== null) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= RAIL_MIN_WIDTH && n <= RAIL_MAX_WIDTH) {
        useTreeStore.setState({ backlinksRailWidth: n });
      }
      // Out-of-range or non-finite → silently fall through to RAIL_DEFAULT_WIDTH.
    }
  } catch {
    // Corrupted storage — fall through to default; do NOT throw.
  }

  try {
    const raw = window.localStorage.getItem(LS_KEY_TAGS_PANEL_HEIGHT_RATIO);
    if (raw !== null) {
      const n = Number.parseFloat(raw);
      if (
        Number.isFinite(n) &&
        n >= TAGS_PANEL_RATIO_MIN &&
        n <= TAGS_PANEL_RATIO_MAX
      ) {
        useTreeStore.setState({ tagsPanelHeightRatio: n });
      }
      // Out-of-range or non-finite → silently fall through to TAGS_PANEL_RATIO_DEFAULT.
    }
  } catch {
    /* localStorage unavailable — keep default */
  }
  try {
    const raw = window.localStorage.getItem(LS_KEY_TAGS_PANEL_EXPANDED);
    if (raw === "false") useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    // any other value (including missing) keeps the default `true`
  } catch {
    /* localStorage unavailable */
  }

  try {
    const raw = window.localStorage.getItem(LS_KEY_SIDEBAR_VISIBLE);
    if (raw === "false") useTreeStore.setState({ notesSidebarVisible: false });
    // any other value (including missing) keeps the default `true`
  } catch {
    /* localStorage unavailable */
  }
  try {
    const rawTags = window.localStorage.getItem(LS_KEY_PANEL_TAGS);
    const rawBacklinks = window.localStorage.getItem(LS_KEY_PANEL_BACKLINKS);
    const panelUpdate: Partial<{ tags: boolean; backlinks: boolean }> = {};
    if (rawTags === "false") panelUpdate.tags = false;
    if (rawBacklinks === "false") panelUpdate.backlinks = false;
    if (Object.keys(panelUpdate).length > 0) {
      useTreeStore.setState((s) => ({
        panelSelector: { ...s.panelSelector, ...panelUpdate },
      }));
    }
    // any other value (including missing) keeps the default `true`
  } catch {
    /* localStorage unavailable */
  }

  try {
    const raw = window.localStorage.getItem(LS_KEY_SWITCHER_RECENCY);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const filtered = parsed
          .filter((x): x is string => typeof x === "string")
          .slice(0, 50);
        if (filtered.length > 0) {
          useTreeStore.setState({ recentlyOpenedNoteIds: filtered });
        }
      }
    }
  } catch {
    /* localStorage unavailable or bad JSON — keep default [] */
  }

  let expandedTimer: ReturnType<typeof setTimeout> | undefined;
  let activeTimer: ReturnType<typeof setTimeout> | undefined;
  let widthTimer: ReturnType<typeof setTimeout> | undefined;
  let lastExpandedJSON = JSON.stringify([...useTreeStore.getState().expanded]);
  let lastActive: string | null = useTreeStore.getState().activeNoteId;
  let lastWidth = useTreeStore.getState().sidebarWidth;

  let lastTagBrowserExpanded = useTreeStore.getState().tagBrowserExpanded;
  let lastBacklinksRailExpanded = useTreeStore.getState().backlinksRailExpanded;
  let lastRailWidth = useTreeStore.getState().backlinksRailWidth;
  let railWidthTimer: ReturnType<typeof setTimeout> | undefined;

  let lastTagsPanelHeightRatio = useTreeStore.getState().tagsPanelHeightRatio;
  let lastRightRailTagsPanelExpanded = useTreeStore.getState().rightRailTagsPanelExpanded;
  let tagsPanelHeightRatioTimer: ReturnType<typeof setTimeout> | undefined;

  let lastNotesSidebarVisible = useTreeStore.getState().notesSidebarVisible;
  let lastPanelTags = useTreeStore.getState().panelSelector.tags;
  let lastPanelBacklinks = useTreeStore.getState().panelSelector.backlinks;

  let lastRecentlyOpenedNoteIds = useTreeStore.getState().recentlyOpenedNoteIds;

  useTreeStore.subscribe((state) => {
    const j = JSON.stringify([...state.expanded]);
    if (j !== lastExpandedJSON) {
      lastExpandedJSON = j;
      if (expandedTimer !== undefined) clearTimeout(expandedTimer);
      expandedTimer = setTimeout(() => {
        try {
          window.localStorage.setItem(LS_KEY_EXPANDED, j);
        } catch {
          // Ignore quota / private-mode failures — persistence is best-effort.
        }
      }, 250);
    }
    if (state.activeNoteId !== lastActive) {
      lastActive = state.activeNoteId;
      if (activeTimer !== undefined) clearTimeout(activeTimer);
      activeTimer = setTimeout(() => {
        try {
          window.localStorage.setItem(
            LS_KEY_ACTIVE_NOTE,
            JSON.stringify(state.activeNoteId),
          );
        } catch {
          // Ignore quota / private-mode failures.
        }
      }, 250);
    }
    if (state.sidebarWidth !== lastWidth) {
      lastWidth = state.sidebarWidth;
      if (widthTimer !== undefined) clearTimeout(widthTimer);
      widthTimer = setTimeout(() => {
        try {
          window.localStorage.setItem(
            LS_KEY_SIDEBAR_WIDTH,
            JSON.stringify(state.sidebarWidth),
          );
        } catch {
          // Quota / private mode — best-effort persistence.
        }
      }, 250);
    }

    if (state.tagBrowserExpanded !== lastTagBrowserExpanded) {
      lastTagBrowserExpanded = state.tagBrowserExpanded;
      try {
        window.localStorage.setItem(LS_KEY_TAG_BROWSER, String(state.tagBrowserExpanded));
      } catch {
        // Quota / private mode — best-effort.
      }
    }
    if (state.backlinksRailExpanded !== lastBacklinksRailExpanded) {
      lastBacklinksRailExpanded = state.backlinksRailExpanded;
      try {
        window.localStorage.setItem(LS_KEY_BACKLINKS_RAIL_EXPANDED, String(state.backlinksRailExpanded));
      } catch {
        // Quota / private mode — best-effort.
      }
    }
    if (state.backlinksRailWidth !== lastRailWidth) {
      lastRailWidth = state.backlinksRailWidth;
      if (railWidthTimer !== undefined) clearTimeout(railWidthTimer);
      railWidthTimer = setTimeout(() => {
        try {
          window.localStorage.setItem(LS_KEY_BACKLINKS_RAIL_WIDTH, String(state.backlinksRailWidth));
        } catch {
          // Quota / private mode — best-effort.
        }
      }, 250);
    }

    if (state.tagsPanelHeightRatio !== lastTagsPanelHeightRatio) {
      lastTagsPanelHeightRatio = state.tagsPanelHeightRatio;
      if (tagsPanelHeightRatioTimer !== undefined) clearTimeout(tagsPanelHeightRatioTimer);
      tagsPanelHeightRatioTimer = setTimeout(() => {
        try {
          window.localStorage.setItem(
            LS_KEY_TAGS_PANEL_HEIGHT_RATIO,
            String(state.tagsPanelHeightRatio),
          );
        } catch {
          // Quota / private mode — best-effort.
        }
      }, 250);
    }
    if (state.rightRailTagsPanelExpanded !== lastRightRailTagsPanelExpanded) {
      lastRightRailTagsPanelExpanded = state.rightRailTagsPanelExpanded;
      try {
        window.localStorage.setItem(
          LS_KEY_TAGS_PANEL_EXPANDED,
          String(state.rightRailTagsPanelExpanded),
        );
      } catch {
        // Quota / private mode — best-effort.
      }
    }

    if (state.notesSidebarVisible !== lastNotesSidebarVisible) {
      lastNotesSidebarVisible = state.notesSidebarVisible;
      try {
        window.localStorage.setItem(LS_KEY_SIDEBAR_VISIBLE, String(state.notesSidebarVisible));
      } catch {
        // Quota / private mode — best-effort.
      }
    }
    if (state.panelSelector.tags !== lastPanelTags) {
      lastPanelTags = state.panelSelector.tags;
      try {
        window.localStorage.setItem(LS_KEY_PANEL_TAGS, String(state.panelSelector.tags));
      } catch {
        // Quota / private mode — best-effort.
      }
    }
    if (state.panelSelector.backlinks !== lastPanelBacklinks) {
      lastPanelBacklinks = state.panelSelector.backlinks;
      try {
        window.localStorage.setItem(LS_KEY_PANEL_BACKLINKS, String(state.panelSelector.backlinks));
      } catch {
        // Quota / private mode — best-effort.
      }
    }

    if (state.recentlyOpenedNoteIds !== lastRecentlyOpenedNoteIds) {
      lastRecentlyOpenedNoteIds = state.recentlyOpenedNoteIds;
      try {
        window.localStorage.setItem(
          LS_KEY_SWITCHER_RECENCY,
          JSON.stringify(state.recentlyOpenedNoteIds),
        );
      } catch {
        /* Quota / private mode — best-effort. */
      }
    }
  });
}
