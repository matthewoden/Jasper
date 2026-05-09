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

export type RenameKind = "note" | "folder";

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
}

export const useTreeStore = create<TreeStore>((set) => ({
  expanded: new Set<string>(),
  activeNoteId: null,
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

  // 4) Debounced persistence — subscribe to slice changes and flush each
  //    persisted slot on its own 250ms timer. The 250ms debounce avoids
  //    storage thrash during rapid expand/collapse (UI-SPEC §State persistence).
  let expandedTimer: ReturnType<typeof setTimeout> | undefined;
  let activeTimer: ReturnType<typeof setTimeout> | undefined;
  let widthTimer: ReturnType<typeof setTimeout> | undefined;
  let lastExpandedJSON = JSON.stringify([...useTreeStore.getState().expanded]);
  let lastActive: string | null = useTreeStore.getState().activeNoteId;
  let lastWidth = useTreeStore.getState().sidebarWidth;

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
  });
}
