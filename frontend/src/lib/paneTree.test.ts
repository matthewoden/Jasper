/**
 * Tests for paneTree — pure split/collapse/rebalance/clone tree operations.
 *
 * Covers WS-04 (collapse + rebalance), D-10 (never-null final pane), D-16
 * (tab id decoupled from noteId), and the explicit-split-direction resolution
 * (RESEARCH.md Open Question 2).
 */
import { describe, expect, it } from "vitest";

import {
  _findLeaf,
  _leaves,
  _removeLeaf,
  _updLeaf,
  depthAtLeaf,
  moveTab,
  moveTabToIndex,
  newLeaf,
  newTabId,
  setRatioAtPath,
  splitPane,
  splitWithTab,
  togglePinInTabs,
  type LeafNode,
  type PaneNode,
} from "./paneTree";

function tabsOf(leaf: LeafNode, noteId: string): number {
  return leaf.tabs.filter((t) => t.noteId === noteId).length;
}

function asLeaf(node: PaneNode): LeafNode {
  if (node.t !== "leaf") throw new Error("expected leaf");
  return node;
}

function asSplit(node: PaneNode) {
  if (node.t !== "split") throw new Error("expected split");
  return node;
}

describe("splitPane", () => {
  it("splits a leaf into two leaves at ratio 0.5", () => {
    const leaf = newLeaf("root");
    const tree = splitPane(leaf, "root", "row", false);
    expect(tree.t).toBe("split");
    if (tree.t !== "split") throw new Error("expected split");
    expect(tree.ratio).toBe(0.5);
    expect(tree.dir).toBe("row");
    expect(tree.a.t).toBe("leaf");
    expect(tree.b.t).toBe("leaf");
  });

  it("clone carries the same noteId with a DIFFERENT tab id", () => {
    const tabId = newTabId();
    const leaf = newLeaf("root", [{ id: tabId, noteId: "note-1" }], tabId);
    const tree = splitPane(leaf, "root", "row", true);
    if (tree.t !== "split") throw new Error("expected split");
    const original = tree.a as LeafNode;
    const clone = tree.b as LeafNode;
    expect(original.tabs).toHaveLength(1);
    expect(clone.tabs).toHaveLength(1);
    expect(clone.tabs[0].noteId).toBe("note-1");
    expect(clone.tabs[0].id).not.toBe(tabId);
    expect(clone.active).toBe(clone.tabs[0].id);
  });

  it("splitting an empty leaf (active=null) is safe: two empty leaves, no phantom tab, no throw", () => {
    const leaf = newLeaf("root"); // no tabs, active=null (D-10 empty-pane state)
    expect(() => splitPane(leaf, "root", "col", true)).not.toThrow();
    const tree = splitPane(leaf, "root", "col", true);
    if (tree.t !== "split") throw new Error("expected split");
    const a = tree.a as LeafNode;
    const b = tree.b as LeafNode;
    expect(a.tabs).toHaveLength(0);
    expect(b.tabs).toHaveLength(0);
    expect(b.active).toBeNull();
  });

  it("honors the explicit split direction unconditionally, regardless of a differently-directed ancestor", () => {
    // Ancestor split is "row"; splitting a descendant leaf with dir="col"
    // must yield "col" at that nested split, not inherit "row".
    const leaf = newLeaf("child");
    const rowTree = splitPane(newLeaf("root"), "root", "row", false);
    if (rowTree.t !== "split") throw new Error("expected split");
    // Rebuild: replace `b` (a leaf) with our named "child" leaf to split further.
    const treeWithChild: PaneNode = { ...rowTree, b: leaf };
    const nested = splitPane(treeWithChild, "child", "col", false);
    if (nested.t !== "split") throw new Error("expected outer split");
    expect(nested.dir).toBe("row"); // outer ancestor unaffected
    const inner = nested.b;
    if (inner.t !== "split") throw new Error("expected inner split");
    expect(inner.dir).toBe("col"); // explicit direction honored regardless of ancestor
  });

  it("returns the tree unchanged when leafId is not found", () => {
    const leaf = newLeaf("root");
    const result = splitPane(leaf, "missing", "row", false);
    expect(result).toBe(leaf);
  });
});

describe("_removeLeaf — collapse + rebalance (WS-04)", () => {
  it("2-leaf tree collapse: removing one leaf returns the sibling subtree", () => {
    const tree = asSplit(splitPane(newLeaf("root"), "root", "row", false));
    const siblingId = asLeaf(tree.b).id;
    const collapsed = _removeLeaf(tree, "root");
    expect(collapsed.t).toBe("leaf");
    expect(asLeaf(collapsed).id).toBe(siblingId);
  });

  it("removing the only remaining leaf returns a single empty leaf, never null (D-10)", () => {
    const leaf = newLeaf("only", [{ id: "t1", noteId: "n1" }], "t1");
    const result = _removeLeaf(leaf, "only");
    expect(result).not.toBeNull();
    expect(result.t).toBe("leaf");
    if (result.t !== "leaf") throw new Error("expected leaf");
    expect(result.tabs).toHaveLength(0);
    expect(result.active).toBeNull();
    expect(result.id).not.toBe("only"); // fresh leaf, not the removed one
  });

  it("rebalances at a nested depth: removing a deeply nested leaf collapses only that split", () => {
    const rowTree = asSplit(splitPane(newLeaf("root"), "root", "row", false));
    const tree = asSplit(splitPane(rowTree, asLeaf(rowTree.a).id, "col", false));
    // tree is now: split(row){ a: split(col){a: leafA, b: leafB}, b: leafC }
    const inner = asSplit(tree.a);
    const leafAId = asLeaf(inner.a).id;
    const leafBId = asLeaf(inner.b).id;
    const leafCId = asLeaf(tree.b).id;

    const result = asSplit(_removeLeaf(tree, leafAId));
    expect(result.a.t).toBe("leaf");
    expect(asLeaf(result.a).id).toBe(leafBId);
    expect(asLeaf(result.b).id).toBe(leafCId);
  });

  it("returns the tree unchanged when leafId is not found in a multi-leaf tree", () => {
    const tree = splitPane(newLeaf("root"), "root", "row", false);
    const result = _removeLeaf(tree, "missing");
    expect(result).toBe(tree);
  });
});

describe("_findLeaf", () => {
  it("finds a leaf by id (hit)", () => {
    const tree = asSplit(splitPane(newLeaf("root"), "root", "row", false));
    expect(_findLeaf(tree, asLeaf(tree.a).id)).toBe(tree.a);
    expect(_findLeaf(tree, asLeaf(tree.b).id)).toBe(tree.b);
  });

  it("returns null when the leaf id is absent (miss)", () => {
    const tree = splitPane(newLeaf("root"), "root", "row", false);
    expect(_findLeaf(tree, "nope")).toBeNull();
  });
});

describe("_leaves", () => {
  it("flattens a single leaf", () => {
    const leaf = newLeaf("solo");
    expect(_leaves(leaf)).toEqual([leaf]);
  });

  it("flattens a split tree in order (a before b)", () => {
    const tree = splitPane(newLeaf("root"), "root", "row", false);
    if (tree.t !== "split") throw new Error("expected split");
    const leaves = _leaves(tree);
    expect(leaves).toHaveLength(2);
    expect(leaves[0]).toBe(tree.a);
    expect(leaves[1]).toBe(tree.b);
  });

  it("flattens a nested tree in in-order sequence", () => {
    const rowTree = asSplit(splitPane(newLeaf("root"), "root", "row", false));
    const tree = splitPane(rowTree, asLeaf(rowTree.a).id, "col", false);
    const leaves = _leaves(tree);
    expect(leaves).toHaveLength(3);
    expect(leaves.every((l) => l.t === "leaf")).toBe(true);
  });
});

describe("_updLeaf", () => {
  it("patches the target leaf and returns a new tree", () => {
    const tree = asSplit(splitPane(newLeaf("root"), "root", "row", false));
    const targetId = asLeaf(tree.a).id;
    const patched = asSplit(_updLeaf(tree, targetId, { active: "some-tab" }));
    expect(patched.a.t).toBe("leaf");
    expect(asLeaf(patched.a).active).toBe("some-tab");
    expect(patched).not.toBe(tree);
  });

  it("returns the tree unchanged when leafId is not found", () => {
    const tree = splitPane(newLeaf("root"), "root", "row", false);
    const result = _updLeaf(tree, "missing", { active: "x" });
    expect(result).toBe(tree);
  });
});

describe("newTabId", () => {
  it("generates distinct ids", () => {
    expect(newTabId()).not.toBe(newTabId());
  });
});

describe("tabsOf helper sanity", () => {
  it("counts tabs by noteId", () => {
    const leaf = newLeaf("l", [
      { id: "a", noteId: "note-1" },
      { id: "b", noteId: "note-1" },
      { id: "c", noteId: "note-2" },
    ]);
    expect(tabsOf(leaf, "note-1")).toBe(2);
    expect(tabsOf(leaf, "note-2")).toBe(1);
  });
});

describe("splitWithTab (WS-01, D-05)", () => {
  it("placement 'first' puts the new sibling (holding the dragged tab) as `a`", () => {
    const leaf = newLeaf("root");
    const tab = { id: newTabId(), noteId: "note-1" };
    const tree = asSplit(splitWithTab(leaf, "root", tab, "row", "first"));
    expect(tree.dir).toBe("row");
    expect(tree.ratio).toBe(0.5);
    expect(asLeaf(tree.a).tabs).toEqual([tab]);
    expect(asLeaf(tree.a).active).toBe(tab.id);
    expect(asLeaf(tree.b).id).toBe("root");
    expect(asLeaf(tree.b).tabs).toHaveLength(0);
  });

  it("placement 'second' puts the new sibling (holding the dragged tab) as `b`", () => {
    const leaf = newLeaf("root");
    const tab = { id: newTabId(), noteId: "note-1" };
    const tree = asSplit(splitWithTab(leaf, "root", tab, "col", "second"));
    expect(tree.dir).toBe("col");
    expect(asLeaf(tree.b).tabs).toEqual([tab]);
    expect(asLeaf(tree.b).active).toBe(tab.id);
    expect(asLeaf(tree.a).id).toBe("root");
  });

  it("honors the explicit dir argument unconditionally", () => {
    const leaf = newLeaf("root");
    const tab = { id: newTabId(), noteId: "note-1" };
    const tree = asSplit(splitWithTab(leaf, "root", tab, "col", "first"));
    expect(tree.dir).toBe("col");
  });

  it("returns the tree unchanged when the target leaf id is absent", () => {
    const leaf = newLeaf("root");
    const tab = { id: newTabId(), noteId: "note-1" };
    const result = splitWithTab(leaf, "missing", tab, "row", "first");
    expect(result).toBe(leaf);
  });

  it("preserves object identity of untouched subtrees", () => {
    const rowTree = asSplit(splitPane(newLeaf("root"), "root", "row", false));
    const untouchedId = asLeaf(rowTree.b).id;
    const tab = { id: newTabId(), noteId: "note-1" };
    const result = asSplit(splitWithTab(rowTree, asLeaf(rowTree.a).id, tab, "col", "first"));
    expect(result.b).toBe(rowTree.b);
    expect(asLeaf(result.b).id).toBe(untouchedId);
  });
});

describe("moveTab (WS-02, D-07)", () => {
  it("appends the tab to the target leaf's tabs and activates it", () => {
    const leaf = newLeaf("root");
    const tab = { id: newTabId(), noteId: "note-1" };
    const result = asLeaf(moveTab(leaf, "root", tab));
    expect(result.tabs).toEqual([tab]);
    expect(result.active).toBe(tab.id);
  });

  it("dedup (D-07): activates the existing tab with the same noteId instead of duplicating", () => {
    const existingTab = { id: newTabId(), noteId: "note-1" };
    const leaf = newLeaf("root", [existingTab], null);
    const draggedTab = { id: newTabId(), noteId: "note-1" };
    const result = asLeaf(moveTab(leaf, "root", draggedTab));
    expect(result.tabs).toEqual([existingTab]);
    expect(result.active).toBe(existingTab.id);
  });

  it("returns the tree unchanged when the target leaf id is absent", () => {
    const leaf = newLeaf("root");
    const tab = { id: newTabId(), noteId: "note-1" };
    const result = moveTab(leaf, "missing", tab);
    expect(result).toBe(leaf);
  });
});

describe("moveTabToIndex (P26 polish — positional cross-leaf insert)", () => {
  it("inserts at index 0 (before every existing tab)", () => {
    const existing = { id: newTabId(), noteId: "note-1" };
    const leaf = newLeaf("root", [existing], existing.id);
    const dragged = { id: newTabId(), noteId: "note-2" };
    const result = asLeaf(moveTabToIndex(leaf, "root", dragged, 0));
    expect(result.tabs.map((t) => t.noteId)).toEqual(["note-2", "note-1"]);
    expect(result.active).toBe(dragged.id);
  });

  it("inserts in the middle of a multi-tab leaf", () => {
    const t1 = { id: newTabId(), noteId: "note-1" };
    const t2 = { id: newTabId(), noteId: "note-2" };
    const leaf = newLeaf("root", [t1, t2], t1.id);
    const dragged = { id: newTabId(), noteId: "note-3" };
    const result = asLeaf(moveTabToIndex(leaf, "root", dragged, 1));
    expect(result.tabs.map((t) => t.noteId)).toEqual(["note-1", "note-3", "note-2"]);
  });

  it("inserts at the end when index === tabs.length", () => {
    const t1 = { id: newTabId(), noteId: "note-1" };
    const leaf = newLeaf("root", [t1], t1.id);
    const dragged = { id: newTabId(), noteId: "note-2" };
    const result = asLeaf(moveTabToIndex(leaf, "root", dragged, 1));
    expect(result.tabs.map((t) => t.noteId)).toEqual(["note-1", "note-2"]);
  });

  it("clamps a negative index to 0", () => {
    const t1 = { id: newTabId(), noteId: "note-1" };
    const leaf = newLeaf("root", [t1], t1.id);
    const dragged = { id: newTabId(), noteId: "note-2" };
    const result = asLeaf(moveTabToIndex(leaf, "root", dragged, -5));
    expect(result.tabs.map((t) => t.noteId)).toEqual(["note-2", "note-1"]);
  });

  it("clamps an out-of-range index (> length) to the end", () => {
    const t1 = { id: newTabId(), noteId: "note-1" };
    const leaf = newLeaf("root", [t1], t1.id);
    const dragged = { id: newTabId(), noteId: "note-2" };
    const result = asLeaf(moveTabToIndex(leaf, "root", dragged, 99));
    expect(result.tabs.map((t) => t.noteId)).toEqual(["note-1", "note-2"]);
  });

  it("dedup (D-07): activates the existing same-noteId tab instead of inserting a duplicate", () => {
    const existing = { id: newTabId(), noteId: "note-1" };
    const leaf = newLeaf("root", [existing], null);
    const dragged = { id: newTabId(), noteId: "note-1" };
    const result = asLeaf(moveTabToIndex(leaf, "root", dragged, 0));
    expect(result.tabs).toEqual([existing]);
    expect(result.active).toBe(existing.id);
  });

  it("returns the tree unchanged when the target leaf id is absent", () => {
    const leaf = newLeaf("root");
    const tab = { id: newTabId(), noteId: "note-1" };
    const result = moveTabToIndex(leaf, "missing", tab, 0);
    expect(result).toBe(leaf);
  });
});

describe("depthAtLeaf (P28 QUICK-03 max-depth guard)", () => {
  it("returns 0 for a root leaf", () => {
    const leaf = newLeaf("root");
    expect(depthAtLeaf(leaf, "root")).toBe(0);
  });

  it("returns 1 for a leaf one split deep", () => {
    const tree = asSplit(splitPane(newLeaf("root"), "root", "row", false));
    expect(depthAtLeaf(tree, asLeaf(tree.a).id)).toBe(1);
    expect(depthAtLeaf(tree, asLeaf(tree.b).id)).toBe(1);
  });

  it("returns the correct depth for leaves nested multiple splits deep", () => {
    const rowTree = asSplit(splitPane(newLeaf("root"), "root", "row", false));
    const tree = asSplit(splitPane(rowTree, asLeaf(rowTree.a).id, "col", false));
    // tree: split(row){ a: split(col){a: leafA, b: leafB}, b: leafC }
    const inner = asSplit(tree.a);
    expect(depthAtLeaf(tree, asLeaf(inner.a).id)).toBe(2);
    expect(depthAtLeaf(tree, asLeaf(inner.b).id)).toBe(2);
    expect(depthAtLeaf(tree, asLeaf(tree.b).id)).toBe(1);
  });

  it("returns 0 when the leaf id is absent (safe default, no guard block)", () => {
    const tree = splitPane(newLeaf("root"), "root", "row", false);
    expect(depthAtLeaf(tree, "missing")).toBe(0);
  });
});

describe("setRatioAtPath (WS-05, D-13)", () => {
  it("writes the ratio at the root split when path is empty", () => {
    const tree = asSplit(splitPane(newLeaf("root"), "root", "row", false));
    const result = asSplit(setRatioAtPath(tree, [], 0.35));
    expect(result.ratio).toBe(0.35);
  });

  it("walks a path of a/b steps to a nested split", () => {
    const rowTree = asSplit(splitPane(newLeaf("root"), "root", "row", false));
    const tree = asSplit(splitPane(rowTree, asLeaf(rowTree.a).id, "col", false));
    // tree: split(row){ a: split(col){...}, b: leaf }
    const result = asSplit(setRatioAtPath(tree, ["a"], 0.7));
    expect(asSplit(result.a).ratio).toBe(0.7);
    expect(result.ratio).toBe(0.5); // root untouched
  });

  it("returns the same ref when the path does not resolve to a split node", () => {
    const tree = asSplit(splitPane(newLeaf("root"), "root", "row", false));
    const result = setRatioAtPath(tree, ["a", "a"], 0.7); // tree.a is a leaf, can't descend
    expect(result).toBe(tree);
  });

  it("returns the same ref when the ratio is unchanged", () => {
    const tree = asSplit(splitPane(newLeaf("root"), "root", "row", false));
    const result = setRatioAtPath(tree, [], 0.5);
    expect(result).toBe(tree);
  });

  it("preserves untouched-subtree identity", () => {
    const rowTree = asSplit(splitPane(newLeaf("root"), "root", "row", false));
    const untouched = rowTree.b;
    const result = asSplit(setRatioAtPath(rowTree, [], 0.9));
    expect(result.b).toBe(untouched);
  });
});

describe("togglePinInTabs (D-14 — pin toggle + left-grouping)", () => {
  it("pins an unpinned tab (pinned: undefined -> true)", () => {
    const a = { id: "a", noteId: "note-a" };
    const b = { id: "b", noteId: "note-b" };
    const result = togglePinInTabs([a, b], "a");
    expect(result.find((t) => t.id === "a")?.pinned).toBe(true);
  });

  it("unpins a pinned tab on the second toggle (round-trip)", () => {
    const a = { id: "a", noteId: "note-a", pinned: true };
    const b = { id: "b", noteId: "note-b" };
    const result = togglePinInTabs([a, b], "a");
    expect(result.find((t) => t.id === "a")?.pinned).toBe(false);
  });

  it("pinning moves the tab to the END of the existing pinned group (left-grouped, D-14)", () => {
    const p1 = { id: "p1", noteId: "note-p1", pinned: true };
    const p2 = { id: "p2", noteId: "note-p2", pinned: true };
    const u1 = { id: "u1", noteId: "note-u1" };
    const u2 = { id: "u2", noteId: "note-u2" };
    // Pin u2, which currently sits after u1 — it must land right after p2,
    // before u1 (the pinned/unpinned boundary), not at its original spot.
    const result = togglePinInTabs([p1, p2, u1, u2], "u2");
    expect(result.map((t) => t.id)).toEqual(["p1", "p2", "u2", "u1"]);
    expect(result.find((t) => t.id === "u2")?.pinned).toBe(true);
  });

  it("unpinning moves the tab to the START of the unpinned group (out of the pinned region)", () => {
    const p1 = { id: "p1", noteId: "note-p1", pinned: true };
    const p2 = { id: "p2", noteId: "note-p2", pinned: true };
    const u1 = { id: "u1", noteId: "note-u1" };
    // Unpin p1 (the first pinned tab) — it must land right after p2 (now the
    // sole pinned tab), before u1.
    const result = togglePinInTabs([p1, p2, u1], "p1");
    expect(result.map((t) => t.id)).toEqual(["p2", "p1", "u1"]);
    expect(result.find((t) => t.id === "p1")?.pinned).toBe(false);
  });

  it("returns the SAME array reference when tabId is not found (no-op)", () => {
    const a = { id: "a", noteId: "note-a" };
    const tabs = [a];
    expect(togglePinInTabs(tabs, "missing")).toBe(tabs);
  });
});
