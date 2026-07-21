/**
 * openNoteInLeaf tests (30-02 Task 2): "New note to the right" must clamp
 * its insertion index to the pinned/unpinned boundary (D-16) — a freshly
 * created (always-unpinned) tab can never land inside a leaf's pinned group,
 * even when invoked on a pinned tab with more pinned tabs after it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _findLeaf } from "./paneTree";
import { usePaneStore } from "./usePaneStore";
import { openNoteInLeaf } from "./openNoteInLeaf";

describe("openNoteInLeaf clamps insertion to the pinned boundary (D-16, Phase 30)", () => {
  beforeEach(() => {
    usePaneStore.getState().clearAll();
  });

  afterEach(() => {
    usePaneStore.getState().clearAll();
  });

  it("invoked on a pinned tab with another pinned tab after it: the new tab lands AFTER the whole pinned group, not between the two pinned tabs", () => {
    const leafId = usePaneStore.getState().activePaneId;
    usePaneStore.setState({
      tree: {
        t: "leaf",
        id: leafId,
        tabs: [
          { id: "p1", noteId: "p1", pinned: true },
          { id: "p2", noteId: "p2", pinned: true },
          { id: "u1", noteId: "u1" },
        ],
        active: "p1",
      },
    });

    // "New note to the right" invoked on "p1" (afterTabId="p1") — naive
    // "insert right after p1" would land the new tab AT index 1, between
    // p1 and p2, inside the pinned group. The clamp must push it past p2.
    openNoteInLeaf(leafId, "new-note", "p1");

    const leaf = _findLeaf(usePaneStore.getState().tree, leafId);
    expect(leaf?.tabs.map((t) => t.noteId)).toEqual(["p1", "p2", "new-note", "u1"]);
    expect(leaf?.tabs.find((t) => t.noteId === "new-note")?.pinned).not.toBe(true);
    expect(leaf?.active).toBe(leaf?.tabs.find((t) => t.noteId === "new-note")?.id);
  });

  it("invoked on an unpinned tab: inserts immediately after it (unaffected by an unrelated pinned group)", () => {
    const leafId = usePaneStore.getState().activePaneId;
    usePaneStore.setState({
      tree: {
        t: "leaf",
        id: leafId,
        tabs: [
          { id: "p1", noteId: "p1", pinned: true },
          { id: "u1", noteId: "u1" },
          { id: "u2", noteId: "u2" },
        ],
        active: "u1",
      },
    });

    openNoteInLeaf(leafId, "new-note", "u1");

    const leaf = _findLeaf(usePaneStore.getState().tree, leafId);
    expect(leaf?.tabs.map((t) => t.noteId)).toEqual(["p1", "u1", "new-note", "u2"]);
  });

  it("with no afterTabId (TAB-14 plain new-tab affordance), appends at the end unchanged", () => {
    const leafId = usePaneStore.getState().activePaneId;
    usePaneStore.setState({
      tree: {
        t: "leaf",
        id: leafId,
        tabs: [{ id: "p1", noteId: "p1", pinned: true }],
        active: "p1",
      },
    });

    openNoteInLeaf(leafId, "new-note");

    const leaf = _findLeaf(usePaneStore.getState().tree, leafId);
    expect(leaf?.tabs.map((t) => t.noteId)).toEqual(["p1", "new-note"]);
  });

  it("returns early (no-op) when the leaf id is not found", () => {
    const before = usePaneStore.getState().tree;
    openNoteInLeaf("missing-leaf", "new-note");
    expect(usePaneStore.getState().tree).toBe(before);
  });

  it("activates the existing tab instead of duplicating when noteId is already open in the leaf (dedup)", () => {
    const leafId = usePaneStore.getState().activePaneId;
    usePaneStore.setState({
      tree: {
        t: "leaf",
        id: leafId,
        tabs: [{ id: "existing", noteId: "note-1" }],
        active: null,
      },
    });

    openNoteInLeaf(leafId, "note-1");

    const leaf = _findLeaf(usePaneStore.getState().tree, leafId);
    expect(leaf?.tabs).toHaveLength(1);
    expect(leaf?.active).toBe("existing");
  });
});
