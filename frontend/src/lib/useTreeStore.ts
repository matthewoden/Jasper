/**
 * useTreeStore — Phase 3 zustand store for the file-tree sidebar.
 *
 * Locked shape (UI-SPEC §Forward-compat assert #2 — Phase 4 ADDS, never modifies):
 *   {
 *     expanded:      Set<string>           // canonical folder paths that are expanded
 *     activeNoteId:  string | null         // currently active note's UUID
 *     pendingRename: { kind, target, isNew? } | null
 *     draftCreate:   { kind, parent } | null
 *     selectedRow:   { kind, target } | null  // ← Plan 03-20 (Gap R2-4)
 *   }
 *
 * Persistence (UI-SPEC §State persistence):
 *   - localStorage["jasper.tree.expanded"]      JSON Array<string>
 *   - localStorage["jasper.tree.activeNoteId"]  JSON string-or-null
 *   - Writes are debounced 250ms to avoid storage thrash on rapid expand/collapse.
 *   - Hydration (top-level side-effect) tolerates corrupted storage — bad JSON
 *     silently falls back to defaults; the user just sees their tree as it is.
 *   - `pendingRename`, `draftCreate`, and `selectedRow` are NEVER persisted
 *     (transient slots).
 *
 * `selectedRow` is consumed by App.tsx's document-level F2 listener (Plan
 * 03-20, Gap R2-4): clicking a tree row populates `selectedRow`, then F2
 * dispatched at the document level reads `selectedRow` to route rename to
 * the right row even after focus has shifted to the editor textarea.
 *
 * pruneStaleTreeState(folderPaths, noteIds) is exported for useFileTree to call
 * after every successful tree fetch — it drops expanded entries / activeNoteId
 * that no longer exist in the freshly-fetched tree. It does NOT touch
 * transient slots.
 */
import { create } from "zustand";

// Phase 7 ADD-ONLY: SearchResult type from OpenAPI schema (D-41).
import type { components } from "../api/schema";
type SearchResult = components["schemas"]["SearchResult"];

export const LS_KEY_EXPANDED = "jasper.tree.expanded";

/**
 * Phase 4 addition (UI-SPEC §Forward-compat assert #2 — ADDS, never modifies).
 * Transient — NOT persisted via localStorage. Reconnects on every page load.
 */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting";
export const LS_KEY_ACTIVE_NOTE = "jasper.tree.activeNoteId";

// Phase 5.5 — Plan 05 (UX-09) sidebar width persistence key + default.
// Slice schema lands here so the TreeStore type stays single-source-of-truth;
// Plan 05 owns the LS hydration block and the SidebarHandle component that
// drives `setSidebarWidth`.
export const LS_KEY_SIDEBAR_WIDTH = "jasper.sidebar.width";
export const SIDEBAR_WIDTH_DEFAULT = 260; // also acts as MIN clamp

// Phase 6 — Plan 06-07: right-rail state persistence keys + width constants.
// See 06-UI-SPEC.md §Surface 2 and 06-CONTEXT.md §D-25/D-26.
// activeTagFilter is NOT persisted (transient slot — clears on reload).
export const LS_KEY_TAG_BROWSER = "jasper.tag.browser.expanded";
export const LS_KEY_BACKLINKS_RAIL_EXPANDED = "jasper.backlinks.rail.expanded";
export const LS_KEY_BACKLINKS_RAIL_WIDTH = "jasper.backlinks.rail.width";
export const RAIL_DEFAULT_WIDTH = 280;
export const RAIL_MIN_WIDTH = 220;
export const RAIL_MAX_WIDTH = 480;
export const RAIL_COLLAPSED_WIDTH = 32;

// Phase 6.5 — UX-T-01: right-rail two-panel layout persistence keys + constants.
// See 06.5-UI-SPEC.md §Surface 1-NEW and 06.5-CONTEXT.md §D-02.
export const LS_KEY_TAGS_PANEL_HEIGHT_RATIO = "jasper.rail.tags.height.ratio";
export const LS_KEY_TAGS_PANEL_EXPANDED = "jasper.rail.tags.expanded";

// Phase 6.6 — UX-CHROME-01/02: chrome-level visibility persistence keys.
// See 06.6-CONTEXT.md §D-29 (ADD-only invariant).
// notesSidebarVisible: whether the left notes sidebar is shown (default true)
// panelSelector: which right-rail panels are visible (default both true)
export const LS_KEY_SIDEBAR_VISIBLE = "jasper.chrome.sidebar.visible";
export const LS_KEY_PANEL_TAGS = "jasper.chrome.panel.selector.tags";
export const LS_KEY_PANEL_BACKLINKS = "jasper.chrome.panel.selector.backlinks";

// Phase 7 — ADD-only: switcher recency persistence key.
// See 07-CONTEXT.md §D-41 + 07-UI-SPEC §Forward-Compat Assert #7.
export const LS_KEY_SWITCHER_RECENCY = "jasper:switcher:recency";
export const TAGS_PANEL_RATIO_DEFAULT = 0.5;
export const TAGS_PANEL_RATIO_MIN = 0.2;
export const TAGS_PANEL_RATIO_MAX = 0.8;

// BL-03 (Phase 5.5 gap-closure Plan 11) — editor pane floor. On viewports
// narrower than `SIDEBAR_WIDTH_DEFAULT + EDITOR_MIN = 580px` the sidebar
// is permitted to shrink below MIN so the editor pane keeps at least
// EDITOR_MIN px of space (or 0 on degenerate sub-EDITOR_MIN viewports).
// Mirrored as the same numeric value in SidebarResizeHandle.tsx — the
// duplicated constant is intentional (Plan 11 §output rationale): keeping
// the handle and the store independent avoids an extra import surface for
// a one-line pure number, and the constant is already plan-cited in two
// places (here and the handle) so any future change has to land in both.
const EDITOR_MIN = 320;

export type RenameKind = "note" | "folder" | "file";

export type PendingRename = {
  kind: RenameKind;
  target: string;
  /**
   * Bug D fix — true when the rename was triggered by a create action
   * (the file/folder was just created and the name was never confirmed by
   * the user). Escape or same-name blur should DELETE the node instead of
   * simply closing the input, because leaving it behind with the
   * auto-generated placeholder name ("untitled") is surprising and
   * pollutes the tree.
   *
   * Set to true by useTreeCreateActions after a successful POST.
   * Not set (undefined / falsy) for regular F2 / double-click renames.
   */
  isNew?: boolean;
};
export type DraftCreate = { kind: RenameKind; parent: string };
export type SelectedRow = { kind: RenameKind; target: string };

export interface TreeStore {
  // Persisted slots:
  expanded: Set<string>;
  activeNoteId: string | null;

  // Plan 07-32b (UAT-3 R7) — non-markdown file selected in the sidebar
  // tree. When non-null, EditorPane renders FilePreviewView in the middle
  // pane instead of the markdown editor.
  //
  // Mutual exclusion (D-41 ADD-only):
  //  - setActiveFilePath(non-null) atomically clears activeNoteId inside
  //    the action.
  //  - setActiveNote is UNCHANGED (D-41 forbids modifying existing
  //    actions). Callers (TreeRow.handleNoteClick) MUST invoke
  //    setActiveFilePath(null) BEFORE setActiveNote(uuid) to clear the
  //    reciprocal direction.
  //
  // Transient — NOT persisted (mirrors the precedent that "currently
  // open thing" is not preserved across page loads for file-preview;
  // activeNoteId IS persisted because note state survives reloads).
  activeFilePath: string | null;
  setActiveFilePath: (p: string | null) => void;

  // Transient slots (never persisted):
  pendingRename: PendingRename | null;
  draftCreate: DraftCreate | null;
  // Plan 03-20 (Gap R2-4): tracks the most-recently-clicked tree row
  // regardless of where DOM focus actually is. App.tsx's document-level
  // F2 listener reads this to route the keystroke to the right row even
  // when DOM focus has shifted to the editor textarea (the
  // EditorPane.useEffect at EditorPane.tsx focuses the textarea on
  // loadStatus === "loaded"). NOT persisted (matches pendingRename /
  // draftCreate precedent).
  selectedRow: SelectedRow | null;

  // Phase 4 addition (UI-SPEC §Forward-compat assert #2 — ADDS, never modifies).
  // Transient — NOT persisted. Reset to "connecting" on every page load.
  // TREE-12: consumed by ConnectionStatusDot and EditorPane (Plan 04-05).
  connectionStatus: ConnectionStatus;

  // Phase 5.5 — UX-08: live H1 → tree label override (transient).
  // Keyed by note id; cleared on note switch with unsaved edits and on
  // successful save (Plan 04 wires the switch path; saved-transition cleanup
  // is best-effort via pruneStaleTreeState when the post-rename tree refresh
  // drops the old id, OR explicit clear in EditorPane savedTimer scheduling).
  // NEVER persisted — same precedent as pendingRename / draftCreate / selectedRow.
  liveLabels: Record<string, string>;
  setLiveLabel: (id: string, label: string) => void;
  clearLiveLabel: (id: string) => void;

  // Phase 5.5 — UX-09 (slice declared here; LS hydration + setter wired by Plan 05).
  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;

  // Mutators:
  toggleExpanded: (path: string) => void;
  setActiveNote: (id: string | null) => void;
  /**
   * startRename — enter inline-rename mode for the node identified by
   * `kind` + `target` (note uuid or folder path).
   *
   * Pass `isNew: true` when the rename is the first-time naming of a
   * just-created node (see PendingRename.isNew for semantics). Omit or
   * pass false for ordinary F2 / double-click renames.
   */
  startRename: (kind: RenameKind, target: string, isNew?: boolean) => void;
  endRename: () => void;
  startDraftCreate: (kind: RenameKind, parent: string) => void;
  endDraftCreate: () => void;
  setSelectedRow: (sr: SelectedRow | null) => void;

  // Phase 4 setter for connectionStatus.
  setConnectionStatus: (s: ConnectionStatus) => void;

  // Phase 6 ADD-only extension (see 06-UI-SPEC.md §State Management Additions).
  // tagBrowserExpanded and backlinksRailExpanded persist to localStorage.
  // backlinksRailWidth persists to localStorage with min/max clamping.
  // activeTagFilter is NOT persisted — transient, clears on reload.
  tagBrowserExpanded: boolean;
  setTagBrowserExpanded: (v: boolean) => void;
  activeTagFilter: string | null;
  setActiveTagFilter: (t: string | null) => void;
  backlinksRailExpanded: boolean;
  setBacklinksRailExpanded: (v: boolean) => void;
  backlinksRailWidth: number;
  setBacklinksRailWidth: (w: number) => void;

  // Phase 6.5 ADD-ONLY (UX-T-01). See 06.5-UI-SPEC §Surface 1-NEW state.
  // tagBrowserExpanded left untouched (the left-sidebar mount is removed
  // in Plan 04 but the slice is preserved for Phase 4 forward-compat).
  tagsPanelHeightRatio: number;
  setTagsPanelHeightRatio: (r: number) => void;
  rightRailTagsPanelExpanded: boolean;
  setRightRailTagsPanelExpanded: (v: boolean) => void;

  // Phase 6.6 ADD-ONLY (UX-CHROME-01, UX-CHROME-02). See 06.6-CONTEXT.md §D-29.
  // Chrome-level visibility state — does NOT modify existing panel expand/collapse slices.
  // notesSidebarVisible: whether the left notes sidebar panel is visible as a whole.
  // panelSelector: which right-rail panels are visible (both default true).
  // These coexist with rightRailTagsPanelExpanded / backlinksRailExpanded (two-level model:
  //   panelSelector = visible/hidden at rail level; existing slices = collapsed-within-card).
  notesSidebarVisible: boolean;
  setNotesSidebarVisible: (v: boolean) => void;
  panelSelector: { tags: boolean; backlinks: boolean };
  setPanelSelector: (update: Partial<{ tags: boolean; backlinks: boolean }>) => void;

  // UAT follow-up 2026-05-12: transient pulse-highlight target for breadcrumb
  // jumps. Set when a breadcrumb folder is clicked; FileTree reads this to
  // apply a brief animation class to the matching row, then auto-clears
  // ~600ms later via setTimeout in pulseTarget setter. NEVER persisted.
  pulseTarget: { kind: "folder" | "note"; target: string } | null;
  setPulseTarget: (t: { kind: "folder" | "note"; target: string } | null) => void;

  // Phase 7 ADD-ONLY (D-41 / UI-SPEC §Forward-Compatibility Assert #7).
  // See .planning/phases/07-search-daily-notes-attachments-palette-switcher/07-CONTEXT.md.
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  searchResults: SearchResult[];
  setSearchResults: (r: SearchResult[]) => void;
  searchActive: boolean;
  setSearchActive: (v: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  // Plan 07-40 (UAT-6): added "search" as a third PaletteMode value alongside
  // "notes" (Cmd+O switcher) and "commands" (Cmd+P palette). Cmd+Shift+F now
  // opens CommandMenu with mode='search' (see App.tsx handleAppCmdShiftF).
  paletteMode: "notes" | "commands" | "search";
  setPaletteMode: (m: "notes" | "commands" | "search") => void;
  recentlyOpenedNoteIds: string[];
  recordOpenedNote: (id: string) => void;
  dailyNoteLoading: boolean;
  setDailyNoteLoading: (v: boolean) => void;
  cheatSheetOpen: boolean;
  setCheatSheetOpen: (v: boolean) => void;

  // Phase 7 Plan 07-28 ADD-ONLY (UAT-2 N9 / B3): hoisted saveState so
  // StatusBar (Phase 06.6 D-07 metadata zone) can render the SaveIndicator.
  // EditorPane mirrors its local saveState reducer into this slice via a
  // useEffect. Reads the same SaveState union as SaveIndicator's props.
  // ADD-only per D-41 invariant.
  saveState: import("./saveStateMachine").SaveState;
  setSaveState: (s: import("./saveStateMachine").SaveState) => void;

  // Phase 8 Plan 08-10 ADD-ONLY (D-55 / MCP-01 / MCP-02): MCP grants slice.
  // Holds the current set of MCP write grants returned from the backend
  // (GET /api/v1/mcp/grants in 08-08). useMcpGrants composes this slice
  // with the API calls and a WS refresh subscription on `mcp:grant_changed`.
  // mcpEnabled mirrors the wizard / config setting (whether the MCP server
  // is active). Both are transient — they re-hydrate from the backend on
  // every mount (no localStorage persistence — the backend is the source
  // of truth, mirrors the WS-cache-invalidation pattern from PROJECT.md).
  mcpGrants: McpGrant[];
  mcpEnabled: boolean;
  setMcpGrants: (grants: McpGrant[]) => void;
  setMcpEnabled: (enabled: boolean) => void;

  // Phase 8 Plan 08-17c ADD-ONLY (D-55 invariant): vault picker open state.
  // Controls whether the <VaultPicker mode="switch"> modal is open.
  // Transient — NOT persisted. Boot detection in App.tsx uses mode="boot"
  // (always open) rather than this slice. This slice is only for the
  // StatusBar click + Cmd+P "Switch vault…" flow.
  vaultPickerOpen: boolean;
  setVaultPickerOpen: (v: boolean) => void;

  // Phase 8 Plan 08-17d ADD-ONLY (D-55 invariant): vault switch overlay state.
  // Active when a vault.switching WS event has been received and the SPA is
  // waiting for vault.switched (or the 10s V4 failsafe fires). Transient —
  // NOT persisted. Cleared automatically on window.location.reload().
  vaultSwitching: { active: boolean; targetName: string };
  setVaultSwitching: (s: { active: boolean; targetName: string }) => void;
}

// Phase 8 Plan 08-10 ADD-ONLY: MCP grant record shape (mirrors the
// `McpGrant` component from the OpenAPI schema — kept here as a local
// alias to avoid pulling the full schema type into a hot path).
export interface McpGrant {
  folder_path: string;
  level: 1 | 2;
  granted_at: string;
  granted_via: string;
}

export const useTreeStore = create<TreeStore>((set) => ({
  expanded: new Set<string>(),
  activeNoteId: null,
  // Plan 07-32b (UAT-3 R7) — see TreeStore.activeFilePath docs above.
  activeFilePath: null,
  setActiveFilePath: (p) =>
    // Non-null: atomically clear activeNoteId (mutual exclusion — permitted
    // under D-41 ADD-only because this is a NEW action; we're not modifying
    // setActiveNote).
    set(
      p === null
        ? { activeFilePath: null }
        : { activeFilePath: p, activeNoteId: null },
    ),
  pendingRename: null,
  draftCreate: null,
  selectedRow: null,
  connectionStatus: "connecting",
  // Plan 04 (UX-08): transient live H1 → tree label overrides.
  liveLabels: {},
  // Plan 05 (UX-09): default sidebar width — also enforced as MIN by setSidebarWidth.
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
  // Plan 04 (UX-08) — liveLabels mutators.
  setLiveLabel: (id, label) =>
    set((s) => ({ liveLabels: { ...s.liveLabels, [id]: label } })),
  clearLiveLabel: (id) =>
    set((s) => {
      if (!(id in s.liveLabels)) return s; // no-op preserves object identity
      const rest: Record<string, string> = {};
      for (const k of Object.keys(s.liveLabels)) {
        if (k !== id) rest[k] = s.liveLabels[k];
      }
      return { liveLabels: rest };
    }),
  // Plan 05 (UX-09) — clamp to SIDEBAR_WIDTH_DEFAULT (MIN).
  //
  // BL-03 (Phase 5.5 gap-closure Plan 11): on a narrow viewport where the
  // sidebar MIN (260) and the editor floor (320) can't both fit, the
  // sidebar must be allowed to shrink below MIN — otherwise the
  // SidebarResizeHandle's pointermove clamp (which dispatches a sub-MIN
  // width on narrow viewports) gets silently undone here, restoring the
  // exact bug BL-03 closes. The store therefore also clamps against the
  // live viewport's editor headroom: `min(MIN-clamped, innerWidth - 320)`.
  // On normal-width viewports this is a no-op (innerWidth - 320 >= MIN).
  setSidebarWidth: (w) => {
    const minClamped = Math.max(SIDEBAR_WIDTH_DEFAULT, w);
    if (typeof window === "undefined") {
      // SSR / test edge case — no viewport to clamp against; preserve the
      // pre-existing MIN-only behavior.
      set({ sidebarWidth: minClamped });
      return;
    }
    const liveMax = Math.max(0, window.innerWidth - EDITOR_MIN);
    set({ sidebarWidth: Math.min(minClamped, liveMax) });
  },

  // Phase 6 slices (ADD-only — no existing slice modified).
  tagBrowserExpanded: false,
  setTagBrowserExpanded: (v) => set({ tagBrowserExpanded: v }),
  // activeTagFilter is NOT persisted — transient slot (same precedent as pendingRename).
  activeTagFilter: null,
  setActiveTagFilter: (t) => set({ activeTagFilter: t }),
  backlinksRailExpanded: false,
  setBacklinksRailExpanded: (v) => set({ backlinksRailExpanded: v }),
  backlinksRailWidth: RAIL_DEFAULT_WIDTH,
  // Clamping happens at setter time so the store value is always in [MIN, MAX].
  setBacklinksRailWidth: (w) =>
    set({ backlinksRailWidth: Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, w)) }),

  // Phase 6.5 slices (ADD-only — no existing slice modified).
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

  // Phase 6.6 slices (ADD-only — no existing slice modified). UX-CHROME-01/02.
  notesSidebarVisible: true,
  setNotesSidebarVisible: (v) => set({ notesSidebarVisible: v }),
  panelSelector: { tags: true, backlinks: true },
  setPanelSelector: (update) =>
    set((s) => ({ panelSelector: { ...s.panelSelector, ...update } })),

  pulseTarget: null,
  setPulseTarget: (t) => set({ pulseTarget: t }),

  // Phase 7 ADD-ONLY initializers + setters (D-41).
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

  // Phase 7 Plan 07-28 ADD-ONLY (UAT-2 N9 / B3)
  saveState: { status: "idle" },
  setSaveState: (s) => set({ saveState: s }),

  // Phase 8 Plan 08-10 ADD-ONLY (D-55 / MCP-01 / MCP-02).
  mcpGrants: [],
  mcpEnabled: false,
  setMcpGrants: (grants) => set({ mcpGrants: grants }),
  setMcpEnabled: (enabled) => set({ mcpEnabled: enabled }),

  // Phase 8 Plan 08-17c ADD-ONLY (D-55 invariant).
  vaultPickerOpen: false,
  setVaultPickerOpen: (v) => set({ vaultPickerOpen: v }),

  // Phase 8 Plan 08-17d ADD-ONLY (D-55 invariant): vault switch overlay state.
  vaultSwitching: { active: false, targetName: "" },
  setVaultSwitching: (s) => set({ vaultSwitching: s }),
}));

/**
 * Drop expanded entries / activeNoteId not in the freshly-fetched tree.
 * Called by useFileTree after every successful GET /tree. The setState call
 * is gated on actual change so a no-op pass keeps reference identity (which
 * lets memoized consumers skip re-renders).
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

  // Plan 04 (UX-08) + WR-07 (Phase 5.5 gap-closure Plan 13) — drop liveLabels
  // for note ids that no longer exist in the freshly-fetched tree. Build the
  // kept entries up via Object.fromEntries rather than `delete`-mutating a
  // cloned object, so type narrowing on the liveLabels shape survives a
  // future shape change. Identity is still preserved on a no-op pass: we
  // only rebuild when at least one entry would be dropped.
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

// ──────────────────────────────────────────────────────────────────────────
// Hydration + debounced persistence — runs once at module import.
//
// Guarded by `typeof window !== "undefined"` so a server-rendered call
// (we don't do SSR, but cheap insurance) doesn't blow up on `localStorage`.
// ──────────────────────────────────────────────────────────────────────────
if (typeof window !== "undefined") {
  // 1) Hydrate `expanded` from localStorage if a valid array of strings is there.
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

  // 2) Hydrate `activeNoteId` from localStorage if a string-or-null is there.
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

  // 3) Hydrate `sidebarWidth` from localStorage.
  //
  // BL-03 (Phase 5.5 gap-closure Plan 11) — clamp the persisted width
  // against the LIVE viewport's editor-floor headroom on read. A
  // wide-monitor session that saved 1200px must not load at 1200px on a
  // narrow laptop; it should be clamped to `innerWidth - EDITOR_MIN` (or
  // floored at 0 on degenerate sub-EDITOR_MIN viewports). This matches
  // the SidebarResizeHandle.computeMaxWidth narrow-viewport rule so the
  // UI is consistent at module load and after every drag.
  //
  // NOTE: the previous comment claimed the MIN clamp prevented the
  // wide → narrow case ("so a window-resize-narrower from a previous
  // session doesn't leave the editor pane <320px wide"). It did NOT —
  // `Math.max(MIN, n)` only floors UP, never DOWN. The replacement below
  // adds the actual clamp the comment promised.
  try {
    const raw = window.localStorage.getItem(LS_KEY_SIDEBAR_WIDTH);
    if (raw !== null) {
      const n = JSON.parse(raw);
      if (typeof n === "number" && Number.isFinite(n)) {
        const liveMax = Math.max(0, window.innerWidth - EDITOR_MIN);
        // First clamp to MIN (pre-existing rule), then to the live max.
        // On a narrow viewport where liveMax < SIDEBAR_WIDTH_DEFAULT, the
        // min wins and the sidebar may load below its preferred MIN —
        // matches the SidebarResizeHandle's reduced-room degradation.
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

  // 4a) Hydrate Phase 6 slices from localStorage (mirrors the sidebarWidth pattern above).
  //     activeTagFilter is NOT hydrated — it is a transient slot (not persisted).
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

  // 4b) Hydrate Phase 6.5 slices from localStorage.
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

  // 4c) Hydrate Phase 6.6 slices from localStorage (mirrors Phase 6.5 boolean pattern above).
  //     All three keys default to true when absent from localStorage.
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

  // 4d) Hydrate Phase 7 slice: recentlyOpenedNoteIds from localStorage.
  //     Parses JSON array of strings; tolerates parse errors → default [].
  //     All other Phase 7 slices are TRANSIENT (not persisted).
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

  // 4) Debounced persistence — subscribe to slice changes and flush each
  //    persisted slot on its own 250ms timer. The 250ms debounce avoids
  //    storage thrash during rapid expand/collapse (UI-SPEC §State persistence).
  let expandedTimer: ReturnType<typeof setTimeout> | undefined;
  let activeTimer: ReturnType<typeof setTimeout> | undefined;
  let widthTimer: ReturnType<typeof setTimeout> | undefined;
  let lastExpandedJSON = JSON.stringify([...useTreeStore.getState().expanded]);
  let lastActive: string | null = useTreeStore.getState().activeNoteId;
  let lastWidth = useTreeStore.getState().sidebarWidth;

  // Phase 6 persistence tracking variables (appended; no existing variable modified).
  let lastTagBrowserExpanded = useTreeStore.getState().tagBrowserExpanded;
  let lastBacklinksRailExpanded = useTreeStore.getState().backlinksRailExpanded;
  let lastRailWidth = useTreeStore.getState().backlinksRailWidth;
  let railWidthTimer: ReturnType<typeof setTimeout> | undefined;

  // Phase 6.5 persistence tracking variables (appended; no existing variable modified).
  let lastTagsPanelHeightRatio = useTreeStore.getState().tagsPanelHeightRatio;
  let lastRightRailTagsPanelExpanded = useTreeStore.getState().rightRailTagsPanelExpanded;
  let tagsPanelHeightRatioTimer: ReturnType<typeof setTimeout> | undefined;

  // Phase 6.6 persistence tracking variables (appended; no existing variable modified).
  let lastNotesSidebarVisible = useTreeStore.getState().notesSidebarVisible;
  let lastPanelTags = useTreeStore.getState().panelSelector.tags;
  let lastPanelBacklinks = useTreeStore.getState().panelSelector.backlinks;

  // Phase 7 ADD-ONLY: persist recentlyOpenedNoteIds (only persistent Phase 7 slice).
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
    // Plan 05 (UX-09) — persist sidebarWidth on the same 250ms debounce.
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

    // Phase 6 persistence subscribers (ADD-only; no existing branch modified).
    // Boolean keys are debounced at the same 250ms window as other slices.
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
    // backlinksRailWidth is debounced to avoid storage thrash during drag.
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
    // activeTagFilter is intentionally NOT persisted (transient slot).

    // Phase 6.5 persistence subscribers (ADD-only; no existing branch modified).
    // tagsPanelHeightRatio is debounced (mirrors backlinksRailWidth).
    // rightRailTagsPanelExpanded is immediate (mirrors tagBrowserExpanded).
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

    // Phase 6.6 persistence subscribers (ADD-only; no existing branch modified).
    // All three chrome boolean slices are immediate (no debounce — mirrors Phase 6.5 booleans).
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

    // Phase 7 ADD-ONLY: persist recentlyOpenedNoteIds (only persistent Phase 7 slice).
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
