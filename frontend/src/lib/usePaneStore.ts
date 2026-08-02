/**
 * usePaneStore — zustand store owning the recursive split-pane layout tree
 * (WS-08 persistence, WS-07 active-pane tracking, WS-04 collapse/rebalance).
 *
 * Evolves useTabStore.ts's per-vault persistence discipline (debounced write,
 * activeVaultKey capture for hot-swap safety, defensive corruption-tolerant
 * parse) onto a recursive PaneNode tree instead of a flat tab list.
 *
 * Persistence key is NEW (`jasper.layout.<vault>`) — the prior flat tab-list
 * storage key is never read or migrated (pre-launch: no back-compat
 * burden).
 *
 * Tab id is decoupled from noteId: dedup is per-leaf, not workspace wide —
 * the same note may exist as independent tabs in different leaves.
 *
 * deletedTabIds is live-session only and is NEVER persisted, mirroring
 * useTabStore's contract: a session-deleted note's tab stays open
 * read-only until reload, but that state must not outlive one.
 */
import { create } from "zustand";

import {
  _findLeaf,
  _leaves,
  _removeLeaf,
  _updLeaf,
  depthAtLeaf,
  moveTab,
  moveTabToIndex,
  newLeaf,
  newLeafId,
  newTabId,
  setRatioAtPath,
  splitPane,
  splitWithTab,
  togglePinInTabs,
  type LeafNode,
  type PaneNode,
} from "./paneTree";
import type { Tab } from "./useTabStore";

const MAX_DEPTH = 32;

export interface PaneStore {
  tree: PaneNode;
  activePaneId: string;
  deletedTabIds: Set<string>; // live-session only; NEVER persisted

  splitActivePane: (dir: "row" | "col") => void;
  closeTabInLeaf: (leafId: string, tabId: string) => void;
  togglePinTab: (leafId: string, tabId: string) => void;
  setActivePane: (leafId: string) => void;
  setActiveTabInLeaf: (leafId: string, tabId: string) => void;
  reorderTabsInLeaf: (leafId: string, fromIndex: number, toIndex: number) => void;
  focusCyclePane: (dir: 1 | -1) => void;
  openInActivePane: (noteId: string) => void;
  openNoteInNewSplit: (noteId: string, dir: "row" | "col") => void;
  openNotesInNewSplit: (noteIds: string[], dir: "row" | "col") => void;
  markDeleted: (noteId: string) => void;
  initForVault: (vaultPath: string) => void;
  clearAll: () => void;
  dropTabOnPane: (
    sourceLeafId: string,
    tabId: string,
    targetLeafId: string,
    region: "left" | "right" | "top" | "bottom" | "center",
  ) => void;
  dropTabAtIndex: (
    sourceLeafId: string,
    tabId: string,
    targetLeafId: string,
    insertIndex: number,
  ) => void;
  setPaneRatio: (path: ("a" | "b")[], ratio: number) => void;
}

export const layoutKeyForVault = (vaultPath: string): string =>
  `jasper.layout.${encodeURIComponent(vaultPath)}`;

function defaultLayout(): { tree: PaneNode; activePaneId: string } {
  const id = newLeafId();
  return { tree: newLeaf(id), activePaneId: id };
}

export const usePaneStore = create<PaneStore>((set, get) => ({
  ...defaultLayout(),
  deletedTabIds: new Set<string>(),

  splitActivePane: (dir) => {
    const { tree, activePaneId } = get();
    const prevLeafIds = new Set(_leaves(tree).map((l) => l.id));
    const nextTree = splitPane(tree, activePaneId, dir, /* cloneActiveTab */ true);
    if (nextTree === tree) return;
    const newSibling = _leaves(nextTree).find((l) => !prevLeafIds.has(l.id));
    set({ tree: nextTree, activePaneId: newSibling ? newSibling.id : activePaneId });
  },

  closeTabInLeaf: (leafId, tabId) => {
    const { tree, activePaneId } = get();
    const leaf = _findLeaf(tree, leafId);
    if (!leaf) return;
    const idx = leaf.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;

    const nextTabs = leaf.tabs.filter((t) => t.id !== tabId);
    const nextActive =
      leaf.active === tabId ? (nextTabs[Math.max(0, idx - 1)]?.id ?? null) : leaf.active;

    if (nextTabs.length > 0) {
      set({ tree: _updLeaf(tree, leafId, { tabs: nextTabs, active: nextActive }) });
      return;
    }

    const allLeaves = _leaves(tree);
    if (allLeaves.length > 1) {
      // Collapse + rebalance; retarget the active pane to a survivor.
      const nextTree = _removeLeaf(tree, leafId);
      const survivors = _leaves(nextTree);
      const nextActivePaneId = survivors.some((l) => l.id === activePaneId)
        ? activePaneId
        : (survivors[0]?.id ?? activePaneId);
      set({ tree: nextTree, activePaneId: nextActivePaneId });
      return;
    }

    // The final pane never collapses — keep it, empty, active=null.
    set({ tree: _updLeaf(tree, leafId, { tabs: nextTabs, active: null }) });
  },

  /**
   * togglePinTab — flips a tab's pinned flag and repositions it to
   * the pinned/unpinned boundary via paneTree's togglePinInTabs, so pinned
   * tabs stay auto-grouped at the left of the strip. Synchronous/pure, like
   * every other tree-shape mutation in this store — persistence rides the
   * existing debounced per-vault subscribe.
   */
  togglePinTab: (leafId, tabId) => {
    const { tree } = get();
    const leaf = _findLeaf(tree, leafId);
    if (!leaf) return;
    const nextTabs = togglePinInTabs(leaf.tabs, tabId);
    if (nextTabs === leaf.tabs) return;
    set({ tree: _updLeaf(tree, leafId, { tabs: nextTabs }) });
  },

  setActivePane: (leafId) => {
    const { tree } = get();
    if (!_findLeaf(tree, leafId)) return;
    set({ activePaneId: leafId });
  },

  setActiveTabInLeaf: (leafId, tabId) => {
    const { tree } = get();
    set({ tree: _updLeaf(tree, leafId, { active: tabId }) });
  },

  reorderTabsInLeaf: (leafId, fromIndex, toIndex) => {
    const { tree } = get();
    const leaf = _findLeaf(tree, leafId);
    if (!leaf) return;
    const nextTabs = [...leaf.tabs];
    const [moved] = nextTabs.splice(fromIndex, 1);
    if (moved === undefined) return;
    nextTabs.splice(toIndex, 0, moved);
    set({ tree: _updLeaf(tree, leafId, { tabs: nextTabs }) });
  },

  focusCyclePane: (dir) => {
    const { tree, activePaneId } = get();
    const leaves = _leaves(tree);
    if (leaves.length < 2) return;
    const idx = leaves.findIndex((l) => l.id === activePaneId);
    const next = (idx + dir + leaves.length) % leaves.length;
    set({ activePaneId: leaves[next].id });
  },

  openInActivePane: (noteId) => {
    const { tree, activePaneId } = get();
    const leaf = _findLeaf(tree, activePaneId);
    if (!leaf) return;
    const existing = leaf.tabs.find((t) => t.noteId === noteId);
    if (existing) {
      set({ tree: _updLeaf(tree, activePaneId, { active: existing.id }) });
      return;
    }
    const tab: Tab = { id: newTabId(), noteId };
    set({ tree: _updLeaf(tree, activePaneId, { tabs: [...leaf.tabs, tab], active: tab.id }) });
  },

  /**
   * openNoteInNewSplit — quick-switcher's split-modifier primitive (QUICK-03):
   * opens an arbitrary note (not necessarily the active tab) into a NEW
   * sibling leaf, distinct from `splitActivePane` which clones the active
   * tab. Guards against unbounded nesting: when the active pane already sits
   * at MAX_DEPTH, or `splitPane` is otherwise a no-op, falls back to
   * `openInActivePane` instead of silently doing nothing.
   */
  openNoteInNewSplit: (noteId, dir) => {
    const { tree, activePaneId } = get();
    if (depthAtLeaf(tree, activePaneId) >= MAX_DEPTH) {
      get().openInActivePane(noteId);
      return;
    }

    const prevLeafIds = new Set(_leaves(tree).map((l) => l.id));
    const nextTree = splitPane(tree, activePaneId, dir, /* cloneActiveTab */ false);
    if (nextTree === tree) {
      get().openInActivePane(noteId);
      return;
    }

    const newSibling = _leaves(nextTree).find((l) => !prevLeafIds.has(l.id));
    if (!newSibling) {
      get().openInActivePane(noteId);
      return;
    }

    const tab: Tab = { id: newTabId(), noteId };
    const finalTree = _updLeaf(nextTree, newSibling.id, { tabs: [tab], active: tab.id });
    set({ tree: finalTree, activePaneId: newSibling.id });
  },

  /**
   * openNotesInNewSplit — bulk-selection sibling to openNoteInNewSplit
   * (CTX-02): opens ONE new split pane containing ALL of `noteIds` as
   * tabs (not N separate splits). Mirrors openNoteInNewSplit's MAX_DEPTH /
   * no-op fallback exactly, falling back to opening each note in the active
   * pane (via openInActivePane, per-leaf deduped) when a new sibling can't
   * be created. A no-op for an empty `noteIds` array.
   */
  openNotesInNewSplit: (noteIds, dir) => {
    if (noteIds.length === 0) return;
    const { tree, activePaneId } = get();
    if (depthAtLeaf(tree, activePaneId) >= MAX_DEPTH) {
      for (const noteId of noteIds) get().openInActivePane(noteId);
      return;
    }

    const prevLeafIds = new Set(_leaves(tree).map((l) => l.id));
    const nextTree = splitPane(tree, activePaneId, dir, /* cloneActiveTab */ false);
    if (nextTree === tree) {
      for (const noteId of noteIds) get().openInActivePane(noteId);
      return;
    }

    const newSibling = _leaves(nextTree).find((l) => !prevLeafIds.has(l.id));
    if (!newSibling) {
      for (const noteId of noteIds) get().openInActivePane(noteId);
      return;
    }

    const tabs: Tab[] = noteIds.map((noteId) => ({ id: newTabId(), noteId }));
    const finalTree = _updLeaf(nextTree, newSibling.id, { tabs, active: tabs[0].id });
    set({ tree: finalTree, activePaneId: newSibling.id });
  },

  /**
   * dropTabOnPane — orchestrates a cross-pane tab drag (WS-01/WS-02): moves
   * (not clones) the dragged tab out of the source leaf and either
   * appends+activates it in the target leaf (region "center", per-leaf
   * dedup via moveTab) or splits the target leaf to host it in a new
   * sibling (edge regions, via splitWithTab). If the source leaf empties as
   * a result and more than one leaf remains, it is collapsed and
   * activePaneId retargets to a survivor; the final pane never collapses
   * (`_removeLeaf`'s own invariant). Same-pane center drops are a no-op.
   * Bails (no `set()`) if source/target is absent, or
   * the drop resolves to no tree change.
   */
  dropTabOnPane: (sourceLeafId, tabId, targetLeafId, region) => {
    const { tree, activePaneId } = get();
    const sourceLeaf = _findLeaf(tree, sourceLeafId);
    if (!sourceLeaf) return;
    const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (!_findLeaf(tree, targetLeafId)) return;
    if (region === "center" && sourceLeafId === targetLeafId) return; // same-pane center drop

    const idx = sourceLeaf.tabs.findIndex((t) => t.id === tabId);
    const nextSourceTabs = sourceLeaf.tabs.filter((t) => t.id !== tabId);
    const nextSourceActive =
      sourceLeaf.active === tabId
        ? (nextSourceTabs[Math.max(0, idx - 1)]?.id ?? null)
        : sourceLeaf.active;

    let intermediate = _updLeaf(tree, sourceLeafId, {
      tabs: nextSourceTabs,
      active: nextSourceActive,
    });
    if (
      nextSourceTabs.length === 0 &&
      _leaves(intermediate).length > 1 &&
      sourceLeafId !== targetLeafId
    ) {
      // Source emptied by the move — collapse + rebalance. Skipped
      // when source === target: an edge-region drop of a leaf's
      // only tab onto its OWN pane must still find that leaf when
      // splitWithTab runs below — collapsing it here (as "the emptied
      // source") would delete the very leaf we're about to split, so
      // splitWithTab silently no-ops and the tab vanishes.
      intermediate = _removeLeaf(intermediate, sourceLeafId);
    }

    const prevLeafIds = new Set(_leaves(intermediate).map((l) => l.id));
    const nextTree =
      region === "center"
        ? moveTab(intermediate, targetLeafId, tab)
        : splitWithTab(
            intermediate,
            targetLeafId,
            tab,
            region === "left" || region === "right" ? "row" : "col",
            region === "left" || region === "top" ? "first" : "second",
          );

    if (nextTree === intermediate) return; // target vanished or no-op

    let nextActivePaneId: string;
    if (region === "center") {
      nextActivePaneId = targetLeafId;
    } else {
      const newSibling = _leaves(nextTree).find((l) => !prevLeafIds.has(l.id));
      nextActivePaneId = newSibling ? newSibling.id : activePaneId;
    }
    if (!_findLeaf(nextTree, nextActivePaneId)) {
      const survivors = _leaves(nextTree);
      nextActivePaneId = survivors[0]?.id ?? activePaneId;
    }

    set({ tree: nextTree, activePaneId: nextActivePaneId });
  },

  /**
   * dropTabAtIndex — the positional counterpart to dropTabOnPane's "center"
   * branch (Obsidian-parity foreign-strip drop, WS-01/WS-02 sibling):
   * removes the dragged tab from the source leaf (retargeting its active tab
   * and collapsing it if it empties and more than one leaf remains), then
   * inserts it at `insertIndex` in the target leaf via moveTabToIndex
   * (positional, not append-only) and activates that leaf. Always a
   * cross-leaf move — same-leaf positional reorder is TabStrip's own
   * in-strip drag path, not this action.
   */
  dropTabAtIndex: (sourceLeafId, tabId, targetLeafId, insertIndex) => {
    if (sourceLeafId === targetLeafId) return;
    const { tree } = get();
    const sourceLeaf = _findLeaf(tree, sourceLeafId);
    if (!sourceLeaf) return;
    const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (!_findLeaf(tree, targetLeafId)) return;

    const idx = sourceLeaf.tabs.findIndex((t) => t.id === tabId);
    const nextSourceTabs = sourceLeaf.tabs.filter((t) => t.id !== tabId);
    const nextSourceActive =
      sourceLeaf.active === tabId
        ? (nextSourceTabs[Math.max(0, idx - 1)]?.id ?? null)
        : sourceLeaf.active;

    let intermediate = _updLeaf(tree, sourceLeafId, {
      tabs: nextSourceTabs,
      active: nextSourceActive,
    });
    if (nextSourceTabs.length === 0 && _leaves(intermediate).length > 1) {
      intermediate = _removeLeaf(intermediate, sourceLeafId);
    }

    const nextTree = moveTabToIndex(intermediate, targetLeafId, tab, insertIndex);
    if (nextTree === intermediate) return; // target vanished or no-op

    set({ tree: nextTree, activePaneId: targetLeafId });
  },

  /**
   * setPaneRatio — writes a split node's ratio by a/b path. The
   * caller (divider drag handler) owns pixel-to-ratio conversion and
   * clamping — this action just applies the value and bails when
   * unchanged. No new persistence code: ratio rides the existing debounced
   * per-vault subscribe (snapshotOf serializes the whole tree).
   */
  setPaneRatio: (path, ratio) => {
    const { tree } = get();
    const next = setRatioAtPath(tree, path, ratio);
    if (next === tree) return;
    set({ tree: next });
  },

  markDeleted: (noteId) =>
    set((s) => {
      const next = new Set(s.deletedTabIds);
      next.add(noteId);
      return { deletedTabIds: next };
    }),

  initForVault: (vaultPath) => {
    const key = layoutKeyForVault(vaultPath);
    activeVaultKey = key;

    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as { tree?: unknown; activePaneId?: unknown };
        if (isValidNode(parsed.tree, 0) && typeof parsed.activePaneId === "string") {
          const tree = parsed.tree;
          const leaves = _leaves(tree);
          const activePaneId = leaves.some((l) => l.id === parsed.activePaneId)
            ? parsed.activePaneId
            : (leaves[0]?.id ?? defaultLayout().activePaneId);
          set({ tree, activePaneId, deletedTabIds: new Set<string>() });
        } else {
          set({ ...defaultLayout(), deletedTabIds: new Set<string>() });
        }
      } else {
        set({ ...defaultLayout(), deletedTabIds: new Set<string>() });
      }
    } catch {
      // Corrupted storage — fall through to a single default leaf; never throw (V5).
      set({ ...defaultLayout(), deletedTabIds: new Set<string>() });
    }

    lastPersistedSnapshot = snapshotOf(get());
    ensureSubscribed();
  },

  clearAll: () => set({ ...defaultLayout(), deletedTabIds: new Set<string>() }),
}));

/**
 * isValidNode — recursive shape validator for a persisted PaneNode.
 * Enforces `t` in {split, leaf}, Array.isArray(tabs) + string ids for leaves,
 * dir/ratio typing for splits, and a depth limit (32) to guard against a
 * maliciously or corruptly deep payload causing a stack overflow.
 */
function isValidNode(node: unknown, depth: number): node is PaneNode {
  if (depth > MAX_DEPTH) return false;
  if (typeof node !== "object" || node === null) return false;
  const n = node as Record<string, unknown>;

  if (n.t === "leaf") {
    return (
      typeof n.id === "string" &&
      Array.isArray(n.tabs) &&
      n.tabs.every(
        (t) =>
          typeof t === "object" &&
          t !== null &&
          typeof (t as Record<string, unknown>).id === "string" &&
          typeof (t as Record<string, unknown>).noteId === "string" &&
          // Reject a malformed persisted `pinned` (anything but
          // boolean-or-undefined) rather than silently coercing it.
          ((t as Record<string, unknown>).pinned === undefined ||
            typeof (t as Record<string, unknown>).pinned === "boolean"),
      ) &&
      (n.active === null || typeof n.active === "string")
    );
  }

  if (n.t === "split") {
    return (
      (n.dir === "row" || n.dir === "col") &&
      // A bare `typeof n.ratio === "number"` check would let
      // a corrupted/hand-edited payload's out-of-range ratio (e.g. -4, 99)
      // through verbatim — SplitRenderer applies it straight to `flex`,
      // producing a degenerate split that only the divider-drag clamp
      // (MIN_PANE_PX) would ever start enforcing, and only once the user
      // grabs the divider.
      typeof n.ratio === "number" &&
      Number.isFinite(n.ratio) &&
      n.ratio > 0 &&
      n.ratio < 1 &&
      isValidNode(n.a, depth + 1) &&
      isValidNode(n.b, depth + 1)
    );
  }

  return false;
}

/**
 * pruneLayoutForMissingNotes — walk every leaf, dropping tabs whose noteId is
 * absent from the freshly-fetched tree, mirroring
 * pruneTabsForMissingNotes. Tabs whose noteId is in deletedTabIds are kept
 * (session-deleted notes stay open read-only). Retargets each leaf's active
 * tab when dropped, and collapses a leaf that empties as a direct result of
 * pruning when more than one leaf remains. Gated on change so a no-op pass
 * preserves reference identity.
 */
export function pruneLayoutForMissingNotes(allNoteIds: Set<string>): void {
  const { tree, activePaneId, deletedTabIds } = usePaneStore.getState();
  const emptiedLeafIds: string[] = [];

  function pruneNode(node: PaneNode): PaneNode {
    if (node.t === "leaf") {
      const cleanTabs = node.tabs.filter(
        (t) => allNoteIds.has(t.noteId) || deletedTabIds.has(t.noteId),
      );
      if (cleanTabs.length === node.tabs.length) return node;
      if (cleanTabs.length === 0 && node.tabs.length > 0) {
        emptiedLeafIds.push(node.id);
      }
      const cleanActive = cleanTabs.some((t) => t.id === node.active)
        ? node.active
        : (cleanTabs[cleanTabs.length - 1]?.id ?? null);
      return { ...node, tabs: cleanTabs, active: cleanActive };
    }
    const a = pruneNode(node.a);
    const b = pruneNode(node.b);
    if (a === node.a && b === node.b) return node;
    return { ...node, a, b };
  }

  let nextTree = pruneNode(tree);
  if (nextTree === tree) return; // nothing dropped

  for (const leafId of emptiedLeafIds) {
    if (_leaves(nextTree).length <= 1) break;
    nextTree = _removeLeaf(nextTree, leafId);
  }

  const survivors = _leaves(nextTree);
  const nextActivePaneId = survivors.some((l) => l.id === activePaneId)
    ? activePaneId
    : (survivors[0]?.id ?? activePaneId);

  usePaneStore.setState({ tree: nextTree, activePaneId: nextActivePaneId });
}

// --- Deferred, vault-scoped persistence -------------------------------------
// activeVaultKey is captured at initForVault time so the writer always targets
// the current vault's key even after a hot-swap. The subscribe is wired once
// (one-time flag) to avoid stacking listeners across repeated initForVault calls.

let activeVaultKey: string | null = null;
let subscribed = false;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let lastPersistedSnapshot = "";

function snapshotOf(state: Pick<PaneStore, "tree" | "activePaneId">): string {
  return JSON.stringify({ tree: state.tree, activePaneId: state.activePaneId });
}

function ensureSubscribed(): void {
  if (subscribed || typeof window === "undefined") return;
  subscribed = true;
  usePaneStore.subscribe((state) => {
    const snap = snapshotOf(state);
    if (snap === lastPersistedSnapshot || activeVaultKey === null) return;
    lastPersistedSnapshot = snap;
    const key = activeVaultKey;
    if (writeTimer !== undefined) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      try {
        window.localStorage.setItem(key, snap);
      } catch {
        // Ignore quota / private-mode failures — persistence is best-effort.
      }
    }, 250);
  });
}

// Exported for use by paneTree consumers that need leaf helpers alongside the store.
export type { LeafNode, PaneNode };
