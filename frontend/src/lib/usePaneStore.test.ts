/**
 * Tests for usePaneStore — the layout-tree Zustand store built on paneTree.ts.
 *
 * Covers WS-08 (per-vault persistence round-trip of tree + activePaneId +
 * ratios, defensive-parse corruption/depth tolerance per T-25-V5), the
 * per-pane openInActivePane dedup primitive (D-16/D-17), closeTabInLeaf
 * collapse/final-pane rules (D-09/D-10), pruneLayoutForMissingNotes (D-13),
 * and focusCyclePane (D-08).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _leaves, newLeaf, newTabId, type PaneNode, type SplitNode } from "./paneTree";
import { layoutKeyForVault, pruneLayoutForMissingNotes, usePaneStore } from "./usePaneStore";

/** Finds the nearest ancestor SplitNode whose direct child (a or b) is the given leaf. */
function findSplitContainingLeaf(tree: PaneNode, leafId: string): SplitNode | null {
  if (tree.t !== "split") return null;
  if ((tree.a.t === "leaf" && tree.a.id === leafId) || (tree.b.t === "leaf" && tree.b.id === leafId)) {
    return tree;
  }
  return findSplitContainingLeaf(tree.a, leafId) ?? findSplitContainingLeaf(tree.b, leafId);
}

function resetStore() {
  const id = newTabId();
  usePaneStore.setState({
    tree: newLeaf(id),
    activePaneId: id,
    deletedTabIds: new Set<string>(),
  });
}

function setRatioOnRoot(tree: PaneNode, ratio: number): PaneNode {
  if (tree.t !== "split") return tree;
  return { ...tree, ratio };
}

/** Builds a nested split tree `depth` levels deep, for the depth-limit test. */
function buildDeepSplit(depth: number): PaneNode {
  let node: PaneNode = { t: "leaf", id: "leaf-0", tabs: [], active: null };
  for (let i = 0; i < depth; i++) {
    node = {
      t: "split",
      dir: "row",
      ratio: 0.5,
      a: node,
      b: { t: "leaf", id: `leaf-extra-${i}`, tabs: [], active: null },
    };
  }
  return node;
}

describe("usePaneStore — splitActivePane (WS-04, D-15)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("creates a sibling leaf and activates it", () => {
    const before = usePaneStore.getState().activePaneId;
    usePaneStore.getState().splitActivePane("row");
    const s = usePaneStore.getState();
    expect(s.tree.t).toBe("split");
    expect(s.activePaneId).not.toBe(before);
    expect(_leaves(s.tree)).toHaveLength(2);
  });

  it("clones the active tab into the sibling under a new tab id (D-15/D-16)", () => {
    usePaneStore.getState().openInActivePane("note-1");
    usePaneStore.getState().splitActivePane("col");
    const leaves = _leaves(usePaneStore.getState().tree);
    expect(leaves).toHaveLength(2);
    expect(leaves[0].tabs.map((t) => t.noteId)).toEqual(["note-1"]);
    expect(leaves[1].tabs.map((t) => t.noteId)).toEqual(["note-1"]);
    expect(leaves[0].tabs[0].id).not.toBe(leaves[1].tabs[0].id);
  });
});

describe("usePaneStore — per-vault persistence (WS-08, T-25-V5)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the jasper.layout.<vault> key", () => {
    const vault = "/Users/me/vault one";
    expect(layoutKeyForVault(vault)).toBe(`jasper.layout.${encodeURIComponent(vault)}`);
  });

  it("round-trips the full tree + activePaneId + ratio through persistence", () => {
    vi.useFakeTimers();
    const vault = "/vault/round-trip";
    usePaneStore.getState().initForVault(vault);
    usePaneStore.getState().openInActivePane("note-1");
    usePaneStore.getState().splitActivePane("row");
    // Ratios persist now even though drag-resize ships in P26 (D-12).
    const withRatio = setRatioOnRoot(usePaneStore.getState().tree, 0.35);
    usePaneStore.setState({ tree: withRatio });
    const secondLeafId = _leaves(usePaneStore.getState().tree)[1].id;
    usePaneStore.getState().setActivePane(secondLeafId);

    vi.advanceTimersByTime(260);

    const before = usePaneStore.getState();
    usePaneStore.getState().initForVault(vault); // reload from the same key
    const after = usePaneStore.getState();

    expect(after.tree).toEqual(before.tree);
    expect(after.activePaneId).toBe(before.activePaneId);
    const rootSplit = after.tree;
    expect(rootSplit.t === "split" ? rootSplit.ratio : undefined).toBe(0.35);
  });

  it("corrupted JSON falls back to a single default leaf without throwing", () => {
    const vault = "/vault/corrupt";
    localStorage.setItem(layoutKeyForVault(vault), "not json{");
    expect(() => usePaneStore.getState().initForVault(vault)).not.toThrow();
    const s = usePaneStore.getState();
    expect(s.tree.t).toBe("leaf");
    expect(_leaves(s.tree)).toHaveLength(1);
  });

  it("a node missing `t` falls back to a single default leaf", () => {
    const vault = "/vault/missing-t";
    localStorage.setItem(
      layoutKeyForVault(vault),
      JSON.stringify({ tree: { id: "x", tabs: [], active: null }, activePaneId: "x" }),
    );
    expect(() => usePaneStore.getState().initForVault(vault)).not.toThrow();
    const s = usePaneStore.getState();
    expect(s.tree.t).toBe("leaf");
    expect(_leaves(s.tree)).toHaveLength(1);
  });

  it("a non-array tabs field falls back to a single default leaf", () => {
    const vault = "/vault/bad-tabs";
    localStorage.setItem(
      layoutKeyForVault(vault),
      JSON.stringify({ tree: { t: "leaf", id: "x", tabs: "not-an-array", active: null }, activePaneId: "x" }),
    );
    expect(() => usePaneStore.getState().initForVault(vault)).not.toThrow();
    const s = usePaneStore.getState();
    expect(s.tree.t).toBe("leaf");
    expect(_leaves(s.tree)).toHaveLength(1);
  });

  it("a >32-deep nested split payload is rejected to a default leaf with no stack overflow", () => {
    const vault = "/vault/too-deep";
    const deepTree = buildDeepSplit(40);
    localStorage.setItem(
      layoutKeyForVault(vault),
      JSON.stringify({ tree: deepTree, activePaneId: "leaf-0" }),
    );
    expect(() => usePaneStore.getState().initForVault(vault)).not.toThrow();
    const s = usePaneStore.getState();
    expect(s.tree.t).toBe("leaf");
    expect(_leaves(s.tree)).toHaveLength(1);
  });

  it.each([-4, 0, 1, 99, NaN, Infinity])(
    "WR-03: a split with an out-of-range ratio (%s) is rejected to a default leaf",
    (badRatio) => {
      const vault = `/vault/bad-ratio-${badRatio}`;
      const tree: PaneNode = {
        t: "split",
        dir: "row",
        ratio: badRatio,
        a: { t: "leaf", id: "leaf-a", tabs: [], active: null },
        b: { t: "leaf", id: "leaf-b", tabs: [], active: null },
      };
      localStorage.setItem(
        layoutKeyForVault(vault),
        JSON.stringify({ tree, activePaneId: "leaf-a" }),
      );
      expect(() => usePaneStore.getState().initForVault(vault)).not.toThrow();
      const s = usePaneStore.getState();
      // Before the fix, `typeof n.ratio === "number"` alone let all of
      // these through, and SplitRenderer would apply the raw ratio (e.g.
      // -4 or 99) straight to `flex`, producing a degenerate split.
      expect(s.tree.t).toBe("leaf");
      expect(_leaves(s.tree)).toHaveLength(1);
    },
  );

  it("WR-03: an in-range ratio (0.35) still round-trips normally", () => {
    const vault = "/vault/good-ratio";
    const tree: PaneNode = {
      t: "split",
      dir: "row",
      ratio: 0.35,
      a: { t: "leaf", id: "leaf-a", tabs: [], active: null },
      b: { t: "leaf", id: "leaf-b", tabs: [], active: null },
    };
    localStorage.setItem(layoutKeyForVault(vault), JSON.stringify({ tree, activePaneId: "leaf-a" }));
    usePaneStore.getState().initForVault(vault);
    const s = usePaneStore.getState();
    expect(s.tree.t === "split" ? s.tree.ratio : undefined).toBe(0.35);
  });
});

describe("usePaneStore — openInActivePane per-pane dedup (D-16/D-17)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("opening an already-open note in the active pane activates it (no duplicate)", () => {
    usePaneStore.getState().openInActivePane("note-1");
    usePaneStore.getState().openInActivePane("note-2");
    usePaneStore.getState().openInActivePane("note-1");
    const leaf = _leaves(usePaneStore.getState().tree)[0];
    const note1Tabs = leaf.tabs.filter((t) => t.noteId === "note-1");
    expect(note1Tabs).toHaveLength(1);
    expect(leaf.active).toBe(note1Tabs[0].id);
  });

  it("the same note may exist as independently-opened tabs in two different leaves", () => {
    usePaneStore.getState().splitActivePane("row"); // no active tab pre-split: sibling starts empty
    const leaves = _leaves(usePaneStore.getState().tree);
    expect(leaves).toHaveLength(2);

    usePaneStore.getState().setActivePane(leaves[0].id);
    usePaneStore.getState().openInActivePane("note-1");
    usePaneStore.getState().setActivePane(leaves[1].id);
    usePaneStore.getState().openInActivePane("note-1");

    const finalLeaves = _leaves(usePaneStore.getState().tree);
    expect(finalLeaves[0].tabs.map((t) => t.noteId)).toEqual(["note-1"]);
    expect(finalLeaves[1].tabs.map((t) => t.noteId)).toEqual(["note-1"]);
    expect(finalLeaves[0].tabs[0].id).not.toBe(finalLeaves[1].tabs[0].id);
  });
});

describe("usePaneStore — closeTabInLeaf collapse rules (D-09/D-10)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("collapses a 2-leaf tree when the last tab in a leaf closes, retargeting activePaneId", () => {
    usePaneStore.getState().openInActivePane("note-1");
    usePaneStore.getState().splitActivePane("row"); // clones note-1; activePaneId -> new sibling
    const [leafA, leafB] = _leaves(usePaneStore.getState().tree);
    expect(usePaneStore.getState().activePaneId).toBe(leafB.id);

    usePaneStore.getState().closeTabInLeaf(leafB.id, leafB.tabs[0].id);

    const s = usePaneStore.getState();
    expect(s.tree.t).toBe("leaf");
    expect(_leaves(s.tree)).toHaveLength(1);
    expect(s.activePaneId).toBe(leafA.id);
  });

  it("keeps the final leaf with active=null when its last tab closes", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const leaf = _leaves(usePaneStore.getState().tree)[0];

    usePaneStore.getState().closeTabInLeaf(leaf.id, leaf.tabs[0].id);

    const s = usePaneStore.getState();
    expect(_leaves(s.tree)).toHaveLength(1);
    expect(s.tree.t).toBe("leaf");
    if (s.tree.t === "leaf") {
      expect(s.tree.tabs).toEqual([]);
      expect(s.tree.active).toBeNull();
    }
  });
});

describe("usePaneStore — pruneLayoutForMissingNotes (D-13)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("drops a stale-noteId tab in a nested leaf and retargets that leaf's active tab", () => {
    usePaneStore.getState().splitActivePane("row");
    const leaves = _leaves(usePaneStore.getState().tree);
    usePaneStore.getState().setActivePane(leaves[1].id);
    usePaneStore.getState().openInActivePane("note-stale");
    usePaneStore.getState().openInActivePane("note-keep");

    pruneLayoutForMissingNotes(new Set(["note-keep"]));

    const nestedLeaf = _leaves(usePaneStore.getState().tree).find((l) => l.id === leaves[1].id);
    expect(nestedLeaf?.tabs.map((t) => t.noteId)).toEqual(["note-keep"]);
    expect(nestedLeaf?.active).toBe(nestedLeaf?.tabs[0].id);
  });

  it("keeps a tab whose note is session-deleted even when absent from allNoteIds", () => {
    usePaneStore.getState().openInActivePane("note-deleted");
    usePaneStore.getState().markDeleted("note-deleted");

    pruneLayoutForMissingNotes(new Set());

    const leaf = _leaves(usePaneStore.getState().tree)[0];
    expect(leaf.tabs.map((t) => t.noteId)).toEqual(["note-deleted"]);
  });

  it("collapses a leaf emptied by pruning when more than one leaf remains", () => {
    usePaneStore.getState().openInActivePane("note-1");
    usePaneStore.getState().splitActivePane("row");
    // Both leaves hold note-1 (cloned by split). Pruning it entirely from
    // both leaves should collapse down to a single surviving leaf.
    pruneLayoutForMissingNotes(new Set());

    const s = usePaneStore.getState();
    const survivors = _leaves(s.tree);
    expect(survivors).toHaveLength(1);
    expect(s.activePaneId).toBe(survivors[0].id);
  });

  it("preserves reference identity when nothing is dropped", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const before = usePaneStore.getState().tree;
    pruneLayoutForMissingNotes(new Set(["note-1"]));
    expect(usePaneStore.getState().tree).toBe(before);
  });
});

describe("usePaneStore — dropTabOnPane (WS-01/WS-02, D-05/D-06/D-07/D-08/D-10)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("region 'left' splits the target: the moved tab's leaf becomes child `a` (row dir)", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const sourceLeafId = usePaneStore.getState().activePaneId;
    usePaneStore.getState().splitActivePane("row"); // empty sibling, no active tab pre-split... actually clones note-1
    const leaves = _leaves(usePaneStore.getState().tree);
    const targetLeafId = leaves.find((l) => l.id !== sourceLeafId)!.id;
    // Give the source leaf a second distinct tab so it doesn't collapse.
    usePaneStore.getState().setActivePane(sourceLeafId);
    usePaneStore.getState().openInActivePane("note-2");
    const sourceLeaf = _leaves(usePaneStore.getState().tree).find((l) => l.id === sourceLeafId)!;
    const draggedTab = sourceLeaf.tabs.find((t) => t.noteId === "note-2")!;

    usePaneStore.getState().dropTabOnPane(sourceLeafId, draggedTab.id, targetLeafId, "left");

    const targetNode = findSplitContainingLeaf(usePaneStore.getState().tree, targetLeafId);
    expect(targetNode?.dir).toBe("row");
    expect(targetNode?.a.t).toBe("leaf");
    if (targetNode?.a.t === "leaf") {
      expect(targetNode.a.tabs.map((t) => t.noteId)).toEqual(["note-2"]);
    }
  });

  it("region 'bottom' splits the target: the moved tab's leaf becomes child `b` (col dir)", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const sourceLeafId = usePaneStore.getState().activePaneId;
    usePaneStore.getState().splitActivePane("row");
    const leaves = _leaves(usePaneStore.getState().tree);
    const targetLeafId = leaves.find((l) => l.id !== sourceLeafId)!.id;
    usePaneStore.getState().setActivePane(sourceLeafId);
    usePaneStore.getState().openInActivePane("note-2");
    const sourceLeaf = _leaves(usePaneStore.getState().tree).find((l) => l.id === sourceLeafId)!;
    const draggedTab = sourceLeaf.tabs.find((t) => t.noteId === "note-2")!;

    usePaneStore.getState().dropTabOnPane(sourceLeafId, draggedTab.id, targetLeafId, "bottom");

    const targetNode = findSplitContainingLeaf(usePaneStore.getState().tree, targetLeafId);
    expect(targetNode?.dir).toBe("col");
    expect(targetNode?.b.t).toBe("leaf");
    if (targetNode?.b.t === "leaf") {
      expect(targetNode.b.tabs.map((t) => t.noteId)).toEqual(["note-2"]);
    }
  });

  it("dragging the ONLY tab out of leaf A onto leaf B collapses A and activates a survivor (D-06)", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const leafAId = usePaneStore.getState().activePaneId;
    usePaneStore.getState().splitActivePane("row"); // clones note-1 into sibling B, activates B
    const leaves = _leaves(usePaneStore.getState().tree);
    const leafBId = leaves.find((l) => l.id !== leafAId)!.id;
    const leafA = leaves.find((l) => l.id === leafAId)!;
    const tabInA = leafA.tabs[0];

    const before = _leaves(usePaneStore.getState().tree).length;
    usePaneStore.getState().dropTabOnPane(leafAId, tabInA.id, leafBId, "center");

    const s = usePaneStore.getState();
    expect(_leaves(s.tree)).toHaveLength(before - 1);
    const survivor = _leaves(s.tree).find((l) => l.id === leafBId)!;
    expect(survivor.tabs.map((t) => t.noteId)).toContain("note-1");
    expect(_leaves(s.tree).some((l) => l.id === s.activePaneId)).toBe(true);
  });

  it("final-pane invariant: with 1 leaf total, dropping onto itself never collapses to zero leaves", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const onlyLeafId = usePaneStore.getState().activePaneId;
    const tab = _leaves(usePaneStore.getState().tree)[0].tabs[0];

    usePaneStore.getState().dropTabOnPane(onlyLeafId, tab.id, onlyLeafId, "left");

    const s = usePaneStore.getState();
    expect(_leaves(s.tree).length).toBeGreaterThanOrEqual(1);
  });

  it("CR-02: dropping a leaf's only tab onto an edge region of ITS OWN pane (2-leaf tree) still splits — does not vanish", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const leafAId = usePaneStore.getState().activePaneId;
    usePaneStore.getState().splitActivePane("row"); // clones note-1 into sibling leaf B
    const leafBId = _leaves(usePaneStore.getState().tree).find((l) => l.id !== leafAId)!.id;
    const leafA = _leaves(usePaneStore.getState().tree).find((l) => l.id === leafAId)!;
    expect(leafA.tabs).toHaveLength(1); // leaf A's ONLY tab — the repro precondition
    const tab = leafA.tabs[0];

    usePaneStore.getState().dropTabOnPane(leafAId, tab.id, leafAId, "left");

    const s = usePaneStore.getState();
    // Before the fix, source-leaf-collapse ran first (2 leaves > 1), deleting
    // leaf A — the very leaf splitWithTab was about to target — so the whole
    // tree came back unchanged and the tab silently vanished from the drop.
    expect(_leaves(s.tree)).toHaveLength(3); // leaf B (untouched) + emptied leaf A + new sibling holding the tab
    expect(_leaves(s.tree).some((l) => l.id === leafBId)).toBe(true);
    const allNoteIds = _leaves(s.tree).flatMap((l) => l.tabs.map((t) => t.noteId));
    expect(allNoteIds.filter((id) => id === "note-1")).toHaveLength(2); // leaf B's clone + the moved tab, nothing lost
  });

  it("same-pane center drop is a no-op (D-08): reference identity preserved", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const leafId = usePaneStore.getState().activePaneId;
    const tab = _leaves(usePaneStore.getState().tree)[0].tabs[0];
    const before = usePaneStore.getState().tree;

    usePaneStore.getState().dropTabOnPane(leafId, tab.id, leafId, "center");

    expect(usePaneStore.getState().tree).toBe(before);
  });

  it("center drop onto a pane already showing the noteId does NOT duplicate the tab (D-07)", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const leafAId = usePaneStore.getState().activePaneId;
    usePaneStore.getState().splitActivePane("row"); // clones note-1 into leaf B
    const leaves = _leaves(usePaneStore.getState().tree);
    const leafBId = leaves.find((l) => l.id !== leafAId)!.id;
    const leafA = leaves.find((l) => l.id === leafAId)!;
    const tabInA = leafA.tabs[0];

    usePaneStore.getState().dropTabOnPane(leafAId, tabInA.id, leafBId, "center");

    const survivor = _leaves(usePaneStore.getState().tree)[0];
    const note1Tabs = survivor.tabs.filter((t) => t.noteId === "note-1");
    expect(note1Tabs).toHaveLength(1);
  });

  it("bails (no-op) when the source leaf is absent", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const before = usePaneStore.getState().tree;
    usePaneStore.getState().dropTabOnPane("missing-leaf", "missing-tab", usePaneStore.getState().activePaneId, "center");
    expect(usePaneStore.getState().tree).toBe(before);
  });

  it("bails (no-op) when the target leaf is absent", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const leafId = usePaneStore.getState().activePaneId;
    const tab = _leaves(usePaneStore.getState().tree)[0].tabs[0];
    const before = usePaneStore.getState().tree;
    usePaneStore.getState().dropTabOnPane(leafId, tab.id, "missing-target", "center");
    expect(usePaneStore.getState().tree).toBe(before);
  });
});

describe("usePaneStore — dropTabAtIndex (P26 polish — positional foreign-strip drop)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("inserts the dragged tab at the requested index in the target leaf's order", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const sourceLeafId = usePaneStore.getState().activePaneId;
    usePaneStore.getState().splitActivePane("row"); // clones note-1 into sibling
    const targetLeafId = _leaves(usePaneStore.getState().tree).find((l) => l.id !== sourceLeafId)!.id;
    usePaneStore.getState().setActivePane(targetLeafId);
    usePaneStore.getState().openInActivePane("note-2"); // target now [note-1(clone), note-2]
    usePaneStore.getState().setActivePane(sourceLeafId);
    usePaneStore.getState().openInActivePane("note-3"); // source now [note-1, note-3]
    const sourceLeaf = _leaves(usePaneStore.getState().tree).find((l) => l.id === sourceLeafId)!;
    const draggedTab = sourceLeaf.tabs.find((t) => t.noteId === "note-3")!;

    usePaneStore.getState().dropTabAtIndex(sourceLeafId, draggedTab.id, targetLeafId, 1);

    const target = _leaves(usePaneStore.getState().tree).find((l) => l.id === targetLeafId)!;
    expect(target.tabs.map((t) => t.noteId)).toEqual(["note-1", "note-3", "note-2"]);
  });

  it("removes the tab from the source leaf and retargets its active tab", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const sourceLeafId = usePaneStore.getState().activePaneId;
    usePaneStore.getState().splitActivePane("row");
    const targetLeafId = _leaves(usePaneStore.getState().tree).find((l) => l.id !== sourceLeafId)!.id;
    usePaneStore.getState().setActivePane(sourceLeafId);
    usePaneStore.getState().openInActivePane("note-2"); // source: [note-1, note-2], active note-2
    const sourceLeaf = _leaves(usePaneStore.getState().tree).find((l) => l.id === sourceLeafId)!;
    const draggedTab = sourceLeaf.tabs.find((t) => t.noteId === "note-2")!;

    usePaneStore.getState().dropTabAtIndex(sourceLeafId, draggedTab.id, targetLeafId, 0);

    const source = _leaves(usePaneStore.getState().tree).find((l) => l.id === sourceLeafId)!;
    expect(source.tabs.map((t) => t.noteId)).toEqual(["note-1"]);
    expect(source.active).toBe(source.tabs[0].id);
  });

  it("collapses the source leaf when its last tab is dragged out (leaf count drops)", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const sourceLeafId = usePaneStore.getState().activePaneId;
    usePaneStore.getState().splitActivePane("row"); // clones note-1 into sibling — sibling becomes active
    const targetLeafId = usePaneStore.getState().activePaneId;
    const sourceLeaf = _leaves(usePaneStore.getState().tree).find((l) => l.id === sourceLeafId)!;
    const draggedTab = sourceLeaf.tabs[0]; // source's ONLY tab

    const before = _leaves(usePaneStore.getState().tree).length;
    usePaneStore.getState().dropTabAtIndex(sourceLeafId, draggedTab.id, targetLeafId, 0);

    expect(_leaves(usePaneStore.getState().tree)).toHaveLength(before - 1);
  });

  it("is a no-op when source and target are the same leaf", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const leafId = usePaneStore.getState().activePaneId;
    const tab = _leaves(usePaneStore.getState().tree)[0].tabs[0];
    const before = usePaneStore.getState().tree;

    usePaneStore.getState().dropTabAtIndex(leafId, tab.id, leafId, 0);

    expect(usePaneStore.getState().tree).toBe(before);
  });

  it("sets activePaneId to the target leaf", () => {
    usePaneStore.getState().openInActivePane("note-1");
    const sourceLeafId = usePaneStore.getState().activePaneId;
    usePaneStore.getState().splitActivePane("row");
    const targetLeafId = _leaves(usePaneStore.getState().tree).find((l) => l.id !== sourceLeafId)!.id;
    usePaneStore.getState().setActivePane(sourceLeafId);
    usePaneStore.getState().openInActivePane("note-2");
    const sourceLeaf = _leaves(usePaneStore.getState().tree).find((l) => l.id === sourceLeafId)!;
    const draggedTab = sourceLeaf.tabs.find((t) => t.noteId === "note-2")!;

    usePaneStore.getState().dropTabAtIndex(sourceLeafId, draggedTab.id, targetLeafId, 0);

    expect(usePaneStore.getState().activePaneId).toBe(targetLeafId);
  });
});

describe("usePaneStore — setPaneRatio (WS-05, D-13)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("writes the ratio at the given path and set()s a new tree", () => {
    usePaneStore.getState().splitActivePane("row");
    const before = usePaneStore.getState().tree;

    usePaneStore.getState().setPaneRatio([], 0.3);

    const after = usePaneStore.getState().tree;
    expect(after).not.toBe(before);
    expect(after.t === "split" ? after.ratio : undefined).toBe(0.3);
  });

  it("bails (no-op) when the ratio is unchanged", () => {
    usePaneStore.getState().splitActivePane("row");
    const before = usePaneStore.getState().tree;

    usePaneStore.getState().setPaneRatio([], 0.5); // DEFAULT_RATIO, already set

    expect(usePaneStore.getState().tree).toBe(before);
  });
});

describe("usePaneStore — focusCyclePane (D-08)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("cycles activePaneId across every leaf, wrapping in both directions", () => {
    usePaneStore.getState().splitActivePane("row");
    usePaneStore.getState().splitActivePane("col");
    const leaves = _leaves(usePaneStore.getState().tree);
    expect(leaves).toHaveLength(3);

    usePaneStore.getState().setActivePane(leaves[0].id);
    usePaneStore.getState().focusCyclePane(1);
    expect(usePaneStore.getState().activePaneId).toBe(leaves[1].id);
    usePaneStore.getState().focusCyclePane(1);
    expect(usePaneStore.getState().activePaneId).toBe(leaves[2].id);
    usePaneStore.getState().focusCyclePane(1);
    expect(usePaneStore.getState().activePaneId).toBe(leaves[0].id);
    usePaneStore.getState().focusCyclePane(-1);
    expect(usePaneStore.getState().activePaneId).toBe(leaves[2].id);
  });

  it("is a no-op with only one leaf", () => {
    const before = usePaneStore.getState().activePaneId;
    usePaneStore.getState().focusCyclePane(1);
    expect(usePaneStore.getState().activePaneId).toBe(before);
  });
});
