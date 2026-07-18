/**
 * usePaneStore — zustand store owning the recursive split-pane layout tree
 * (WS-08 persistence, WS-07 active-pane tracking, WS-04 collapse/rebalance).
 *
 * Evolves useTabStore.ts's per-vault persistence discipline (debounced write,
 * activeVaultKey capture for hot-swap safety, defensive corruption-tolerant
 * parse) onto a recursive PaneNode tree instead of a flat tab list.
 *
 * Persistence key is NEW (`jasper.layout.<vault>`) — the prior flat tab-list
 * storage key is never read or migrated (D-11/D-18, pre-launch: no
 * back-compat burden).
 *
 * Tab id is decoupled from noteId (D-16): dedup is per-leaf, not workspace
 * wide (D-17) — the same note may exist as independent tabs in different
 * leaves.
 *
 * deletedTabIds is live-session only and is NEVER persisted, mirroring
 * useTabStore's D-11 contract: a session-deleted note's tab stays open
 * read-only until reload, but that state must not outlive one.
 */
import { create } from "zustand";

import {
  _findLeaf,
  _leaves,
  _removeLeaf,
  _updLeaf,
  moveTab,
  newLeaf,
  newLeafId,
  newTabId,
  setRatioAtPath,
  splitPane,
  splitWithTab,
  type LeafNode,
  type PaneNode,
} from "./paneTree";
import type { Tab } from "./useTabStore";

const MAX_DEPTH = 32;

export interface PaneStore {
  tree: PaneNode;
  activePaneId: string;
  deletedTabIds: Set<string>; // live-session only; NEVER persisted (D-11 pattern)

  splitActivePane: (dir: "row" | "col") => void;
  closeTabInLeaf: (leafId: string, tabId: string) => void;
  setActivePane: (leafId: string) => void;
  setActiveTabInLeaf: (leafId: string, tabId: string) => void;
  reorderTabsInLeaf: (leafId: string, fromIndex: number, toIndex: number) => void;
  focusCyclePane: (dir: 1 | -1) => void;
  openInActivePane: (noteId: string) => void;
  markDeleted: (noteId: string) => void;
  initForVault: (vaultPath: string) => void;
  clearAll: () => void;
  dropTabOnPane: (
    sourceLeafId: string,
    tabId: string,
    targetLeafId: string,
    region: "left" | "right" | "top" | "bottom" | "center",
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
      // D-09: collapse + rebalance; retarget active pane to a survivor.
      const nextTree = _removeLeaf(tree, leafId);
      const survivors = _leaves(nextTree);
      const nextActivePaneId = survivors.some((l) => l.id === activePaneId)
        ? activePaneId
        : (survivors[0]?.id ?? activePaneId);
      set({ tree: nextTree, activePaneId: nextActivePaneId });
      return;
    }

    // D-10: final pane never collapses — keep it, empty, active=null.
    set({ tree: _updLeaf(tree, leafId, { tabs: nextTabs, active: null }) });
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
   * dropTabOnPane — orchestrates a cross-pane tab drag (WS-01/WS-02): moves
   * (not clones, D-05) the dragged tab out of the source leaf and either
   * appends+activates it in the target leaf (region "center", per-leaf
   * dedup D-07 via moveTab) or splits the target leaf to host it in a new
   * sibling (edge regions, via splitWithTab). If the source leaf empties as
   * a result and more than one leaf remains, it is collapsed and
   * activePaneId retargets to a survivor (D-06); the final pane never
   * collapses (D-10, `_removeLeaf`'s own invariant). Same-pane center drops
   * are a no-op (D-08). Bails (no `set()`) if source/target is absent, or
   * the drop resolves to no tree change.
   */
  dropTabOnPane: (sourceLeafId, tabId, targetLeafId, region) => {
    const { tree, activePaneId } = get();
    const sourceLeaf = _findLeaf(tree, sourceLeafId);
    if (!sourceLeaf) return;
    const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (!_findLeaf(tree, targetLeafId)) return;
    if (region === "center" && sourceLeafId === targetLeafId) return; // D-08

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
      // D-06: source emptied by the move — collapse + rebalance.
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
   * setPaneRatio — writes a split node's ratio by a/b path (D-13). The
   * caller (divider drag handler) owns pixel-to-ratio conversion and
   * clamping (D-14) — this action just applies the value and bails when
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
 * isValidNode — recursive shape validator for a persisted PaneNode (T-25-V5).
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
          typeof (t as Record<string, unknown>).noteId === "string",
      ) &&
      (n.active === null || typeof n.active === "string")
    );
  }

  if (n.t === "split") {
    return (
      (n.dir === "row" || n.dir === "col") &&
      typeof n.ratio === "number" &&
      isValidNode(n.a, depth + 1) &&
      isValidNode(n.b, depth + 1)
    );
  }

  return false;
}

/**
 * pruneLayoutForMissingNotes — walk every leaf, dropping tabs whose noteId is
 * absent from the freshly-fetched tree (D-13), mirroring
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
