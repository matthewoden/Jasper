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

import { _leaves, newLeaf, newTabId, type PaneNode } from "./paneTree";
import { layoutKeyForVault, pruneLayoutForMissingNotes, usePaneStore } from "./usePaneStore";

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
