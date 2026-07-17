/**
 * paneTree — pure, React/Zustand-free operations on the recursive split-pane
 * layout tree (WS-04, D-09, D-10, D-16).
 *
 * Naming mirrors the design source (`DELTA-FROM-v1.2.md` §1) for continuity
 * between design and implementation: `splitPane` / `_updLeaf` / `_removeLeaf` /
 * `_findLeaf` / `_leaves`.
 *
 * Every op returns a NEW tree (immutable-in, immutable-out) — no in-place
 * mutation, matching how `useTabStore.ts`'s array ops already build new arrays.
 *
 * Tab id is intentionally decoupled from noteId (D-16): use `newTabId()`, never
 * `id = noteId`. This lets the same note appear as independent tabs across
 * different leaves without an id collision.
 *
 * `_removeLeaf` on the last remaining leaf returns a single empty default leaf,
 * never null (D-10) — final-pane-never-collapses invariant.
 */
import type { Tab } from "./useTabStore";

export interface SplitNode {
  t: "split";
  dir: "row" | "col";
  ratio: number;
  a: PaneNode;
  b: PaneNode;
}

export interface LeafNode {
  t: "leaf";
  id: string;
  tabs: Tab[];
  active: string | null;
}

export type PaneNode = SplitNode | LeafNode;

const DEFAULT_RATIO = 0.5;

/** Generates a tab id decoupled from noteId (D-16). */
export function newTabId(): string {
  return crypto.randomUUID();
}

/** Builds a new empty leaf (default state: no tabs, no active tab). */
export function newLeaf(id: string, tabs: Tab[] = [], active: string | null = null): LeafNode {
  return { t: "leaf", id, tabs, active };
}

/**
 * Splits the leaf identified by `leafId` into a split node with two leaves:
 * the original leaf (unchanged, becomes `a`) and a fresh sibling leaf (`b`).
 * When `cloneActiveTab` is true and the target leaf has an active tab, the
 * sibling starts with a clone of that tab under a NEW tab id (same noteId,
 * distinct tab id) so it is independently closable. When the target leaf has
 * no active tab (D-10 empty-pane state), cloning is a no-op — the sibling
 * starts empty, with no phantom tab.
 *
 * Honors the EXPLICIT `dir` argument unconditionally, regardless of any
 * ancestor split's direction (RESEARCH.md Open Question 2 resolution) —
 * nesting falls out of `_findLeaf` + replacement with no special-casing.
 *
 * Returns the tree unchanged if `leafId` is not found.
 */
export function splitPane(
  tree: PaneNode,
  leafId: string,
  dir: "row" | "col",
  cloneActiveTab: boolean,
): PaneNode {
  if (tree.t === "leaf") {
    if (tree.id !== leafId) return tree;
    const siblingId = newTabId();
    const activeTab = tree.tabs.find((t) => t.id === tree.active);
    const siblingTabs: Tab[] =
      cloneActiveTab && activeTab
        ? [{ id: newTabId(), noteId: activeTab.noteId }]
        : [];
    const sibling = newLeaf(
      siblingId,
      siblingTabs,
      siblingTabs.length > 0 ? siblingTabs[0].id : null,
    );
    return {
      t: "split",
      dir,
      ratio: DEFAULT_RATIO,
      a: tree,
      b: sibling,
    };
  }

  const a = splitPane(tree.a, leafId, dir, cloneActiveTab);
  if (a !== tree.a) return { ...tree, a };
  const b = splitPane(tree.b, leafId, dir, cloneActiveTab);
  if (b !== tree.b) return { ...tree, b };
  return tree;
}

/**
 * Returns a new tree with the leaf identified by `leafId` patched (shallow
 * merge of `patch` onto that leaf). Returns the tree unchanged if not found.
 */
export function _updLeaf(tree: PaneNode, leafId: string, patch: Partial<LeafNode>): PaneNode {
  if (tree.t === "leaf") {
    if (tree.id !== leafId) return tree;
    return { ...tree, ...patch, t: "leaf", id: tree.id };
  }

  const a = _updLeaf(tree.a, leafId, patch);
  if (a !== tree.a) return { ...tree, a };
  const b = _updLeaf(tree.b, leafId, patch);
  if (b !== tree.b) return { ...tree, b };
  return tree;
}

/**
 * Removes the leaf identified by `leafId`, collapsing + rebalancing the tree
 * (WS-04): when the leaf's parent is a split, the SIBLING subtree replaces the
 * split in the parent's place. Recurses so removal at any depth rebalances
 * correctly.
 *
 * D-10 invariant: removing the ONLY remaining leaf in the tree returns a
 * single new empty leaf — never null. The final pane never collapses away.
 */
export function _removeLeaf(tree: PaneNode, leafId: string): PaneNode {
  if (tree.t === "leaf") {
    if (tree.id === leafId) {
      // Removing the only remaining leaf — return a fresh empty default leaf.
      return newLeaf(newTabId());
    }
    return tree;
  }

  if (tree.a.t === "leaf" && tree.a.id === leafId) return tree.b;
  if (tree.b.t === "leaf" && tree.b.id === leafId) return tree.a;

  const a = _removeLeaf(tree.a, leafId);
  if (a !== tree.a) return { ...tree, a };
  const b = _removeLeaf(tree.b, leafId);
  if (b !== tree.b) return { ...tree, b };
  return tree;
}

/** Locates the leaf with the given id, or null if absent. */
export function _findLeaf(tree: PaneNode, leafId: string): LeafNode | null {
  if (tree.t === "leaf") return tree.id === leafId ? tree : null;
  return _findLeaf(tree.a, leafId) ?? _findLeaf(tree.b, leafId);
}

/** Flattens the tree into an in-order array of leaves (for e.g. focus-cycle, D-08). */
export function _leaves(tree: PaneNode): LeafNode[] {
  if (tree.t === "leaf") return [tree];
  return [..._leaves(tree.a), ..._leaves(tree.b)];
}
