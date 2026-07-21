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

/**
 * Generates a leaf/pane id. Functionally identical to newTabId() (both are
 * just crypto.randomUUID()), but named separately per-call-site for
 * readability (IN-02, 25-REVIEW.md): a leaf id and a tab id occupy distinct
 * id spaces (D-16) and reusing one generator name for both obscured that
 * distinction at call sites that mint a LEAF id, not a tab id.
 */
export function newLeafId(): string {
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
    const siblingId = newLeafId();
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
      return newLeaf(newLeafId());
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

/**
 * Splits the leaf identified by `targetLeafId` into a split node, with the
 * dragged `tab` (MOVED, not cloned — caller removes it from the source leaf)
 * landing in a fresh sibling leaf. `placement` controls which side the new
 * sibling occupies: "first" -> `a`, "second" -> `b` (drop-zone geometry:
 * left/top -> first, right/bottom -> second).
 *
 * Honors the explicit `dir` argument unconditionally, same as `splitPane`.
 * Returns the tree unchanged if `targetLeafId` is not found.
 */
export function splitWithTab(
  tree: PaneNode,
  targetLeafId: string,
  tab: Tab,
  dir: "row" | "col",
  placement: "first" | "second",
): PaneNode {
  if (tree.t === "leaf") {
    if (tree.id !== targetLeafId) return tree;
    const sibling = newLeaf(newLeafId(), [tab], tab.id);
    return placement === "first"
      ? { t: "split", dir, ratio: DEFAULT_RATIO, a: sibling, b: tree }
      : { t: "split", dir, ratio: DEFAULT_RATIO, a: tree, b: sibling };
  }

  const a = splitWithTab(tree.a, targetLeafId, tab, dir, placement);
  if (a !== tree.a) return { ...tree, a };
  const b = splitWithTab(tree.b, targetLeafId, tab, dir, placement);
  if (b !== tree.b) return { ...tree, b };
  return tree;
}

/**
 * Appends `tab` to the target leaf's tabs and activates it. Per-leaf dedup
 * (D-07): if the target leaf already holds a tab with the same `noteId`,
 * activates that existing tab instead of adding a duplicate. A PINNED `tab`
 * (D-15) does not append past the leaf's unpinned tabs — it lands at the end
 * of the target leaf's own pinned group instead, so a cross-pane center-drop
 * of a pinned tab never breaks the left-grouped invariant.
 *
 * Returns the tree unchanged if `targetLeafId` is not found.
 */
export function moveTab(tree: PaneNode, targetLeafId: string, tab: Tab): PaneNode {
  const leaf = _findLeaf(tree, targetLeafId);
  if (!leaf) return tree;
  const existing = leaf.tabs.find((t) => t.noteId === tab.noteId);
  if (existing) {
    return _updLeaf(tree, targetLeafId, { active: existing.id });
  }
  if (tab.pinned) {
    const boundary = leaf.tabs.filter((t) => t.pinned).length;
    const tabs = [...leaf.tabs.slice(0, boundary), tab, ...leaf.tabs.slice(boundary)];
    return _updLeaf(tree, targetLeafId, { tabs, active: tab.id });
  }
  return _updLeaf(tree, targetLeafId, { tabs: [...leaf.tabs, tab], active: tab.id });
}

/**
 * Inserts `tab` at `insertIndex` (clamped to [0, tabs.length]) in the target
 * leaf's tabs and activates it — the positional counterpart to `moveTab`'s
 * append-only insert, used by TabStrip's foreign-strip drop (P26 Obsidian
 * parity: dropping onto a specific pill position lands there, not at the
 * end). Per-leaf dedup (D-07) still applies: an existing same-noteId tab is
 * activated in place rather than duplicated.
 *
 * Returns the tree unchanged if `targetLeafId` is not found.
 */
export function moveTabToIndex(
  tree: PaneNode,
  targetLeafId: string,
  tab: Tab,
  insertIndex: number,
): PaneNode {
  const leaf = _findLeaf(tree, targetLeafId);
  if (!leaf) return tree;
  const existing = leaf.tabs.find((t) => t.noteId === tab.noteId);
  if (existing) {
    return _updLeaf(tree, targetLeafId, { active: existing.id });
  }
  const idx = Math.max(0, Math.min(insertIndex, leaf.tabs.length));
  const tabs = [...leaf.tabs.slice(0, idx), tab, ...leaf.tabs.slice(idx)];
  return _updLeaf(tree, targetLeafId, { tabs, active: tab.id });
}

/**
 * Walks `path` (a sequence of "a"|"b" steps from `tree`) to a split node and
 * writes its `ratio`. No clamping here — that is the caller's job (store
 * owns pixel dimensions). Returns the tree unchanged when the path does not
 * resolve to a split node, or the ratio is already the requested value.
 */
export function setRatioAtPath(tree: PaneNode, path: ("a" | "b")[], ratio: number): PaneNode {
  if (path.length === 0) {
    if (tree.t !== "split" || tree.ratio === ratio) return tree;
    return { ...tree, ratio };
  }
  if (tree.t !== "split") return tree;

  const [step, ...rest] = path;
  if (step === "a") {
    const a = setRatioAtPath(tree.a, rest, ratio);
    if (a === tree.a) return tree;
    return { ...tree, a };
  }
  const b = setRatioAtPath(tree.b, rest, ratio);
  if (b === tree.b) return tree;
  return { ...tree, b };
}

/**
 * depthAtLeaf — counts split-node ancestors between `tree` and the leaf
 * identified by `leafId` (P28 QUICK-03 max-depth guard). A root leaf (no
 * ancestor splits) is depth 0; each split traversed on the way down adds 1.
 * Returns 0 (a safe non-blocking default) when `leafId` is not found —
 * callers only use this to gate a split action, and a missing leaf id is
 * itself an unrelated no-op case handled elsewhere (e.g. `splitPane`
 * returning the tree unchanged).
 */
export function depthAtLeaf(tree: PaneNode, leafId: string): number {
  function walk(node: PaneNode, depth: number): number | null {
    if (node.t === "leaf") return node.id === leafId ? depth : null;
    return walk(node.a, depth + 1) ?? walk(node.b, depth + 1);
  }
  return walk(tree, 0) ?? 0;
}

/**
 * Flips a tab's `pinned` flag and repositions it to the pinned/unpinned
 * boundary (D-14) so pinned tabs stay auto-grouped at the left of the strip
 * regardless of where the toggle was invoked from. Both directions land at
 * the SAME index — the count of the tab's new sibling group (other pinned
 * tabs when pinning, i.e. the tab becomes the last pinned tab; other pinned
 * tabs when unpinning too, since that index is exactly where the unpinned
 * group begins). Returns `tabs` unchanged (same reference) if `tabId` is not
 * found, so callers can cheaply detect a no-op.
 */
export function togglePinInTabs(tabs: Tab[], tabId: string): Tab[] {
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return tabs;
  const target = tabs[idx];
  const updated: Tab = { ...target, pinned: !target.pinned };
  const withoutTarget = [...tabs.slice(0, idx), ...tabs.slice(idx + 1)];
  const boundary = withoutTarget.filter((t) => t.pinned).length;
  return [...withoutTarget.slice(0, boundary), updated, ...withoutTarget.slice(boundary)];
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
