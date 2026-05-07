/**
 * useTreeStore — Phase 3 zustand store for the file-tree sidebar.
 *
 * Locked shape (UI-SPEC §Forward-compat assert #2 — Phase 4 ADDS, never modifies):
 *   {
 *     expanded:      Set<string>           // canonical folder paths that are expanded
 *     activeNoteId:  string | null         // currently active note's UUID
 *     pendingRename: { kind, target } | null
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

export type RenameKind = "note" | "folder";

export type PendingRename = { kind: RenameKind; target: string };
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

  // Mutators:
  toggleExpanded: (path: string) => void;
  setActiveNote: (id: string | null) => void;
  startRename: (kind: RenameKind, target: string) => void;
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
  toggleExpanded: (path) =>
    set((s) => {
      const next = new Set(s.expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expanded: next };
    }),
  setActiveNote: (id) => set({ activeNoteId: id }),
  startRename: (kind, target) => set({ pendingRename: { kind, target } }),
  endRename: () => set({ pendingRename: null }),
  startDraftCreate: (kind, parent) => set({ draftCreate: { kind, parent } }),
  endDraftCreate: () => set({ draftCreate: null }),
  setSelectedRow: (sr) => set({ selectedRow: sr }),
  setConnectionStatus: (s) => set({ connectionStatus: s }),
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
  const expandedChanged = cleanExpanded.size !== s.expanded.size;
  const activeChanged = cleanActive !== s.activeNoteId;
  if (expandedChanged || activeChanged) {
    useTreeStore.setState({
      ...(expandedChanged ? { expanded: cleanExpanded } : {}),
      ...(activeChanged ? { activeNoteId: cleanActive } : {}),
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

  // 3) Debounced persistence — subscribe to slice changes and flush each
  //    persisted slot on its own 250ms timer. The 250ms debounce avoids
  //    storage thrash during rapid expand/collapse (UI-SPEC §State persistence).
  let expandedTimer: ReturnType<typeof setTimeout> | undefined;
  let activeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastExpandedJSON = JSON.stringify([...useTreeStore.getState().expanded]);
  let lastActive: string | null = useTreeStore.getState().activeNoteId;

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
  });
}
