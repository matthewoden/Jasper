/**
 * PaneTree tests (Phase 25 Plan 06 Task 2):
 *   - A tree with N leaves renders N independent `[data-testid="leaf-pane"]`,
 *     each with its own `[data-testid="tab-strip"]`.
 *   - The active leaf carries `data-active-pane="true"`; an inactive leaf
 *     does not.
 *   - Clicking anywhere in an inactive leaf's chrome calls
 *     usePaneStore's setActivePane with that leaf's id (D-04).
 *   - A leaf with `active: null` (D-10, zero tabs) renders without crashing.
 *   - Split nodes render a `[data-testid="pane-divider"]` between children.
 *
 * `EditorPane` is mocked to a lightweight stub — this suite exercises
 * PaneTree/LeafPane's layout/composition/click-to-activate behavior, not the
 * full editor stack (covered exhaustively by EditorPane.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PaneTree } from "./PaneTree";
import { usePaneStore } from "../lib/usePaneStore";
import type { LeafNode, PaneNode } from "../lib/paneTree";
import type { Tab } from "../lib/useTabStore";

vi.mock("./EditorPane", () => ({
  EditorPane: ({ noteId, hidden }: { noteId: string | null; hidden?: boolean }) => (
    <div
      data-testid="editor-pane-stub"
      data-note-id={noteId ?? "null"}
      data-hidden={String(!!hidden)}
    />
  ),
}));

const tabA: Tab = { id: "tab-a", noteId: "note-a" };
const tabB: Tab = { id: "tab-b", noteId: "note-b" };

const leafA: LeafNode = { t: "leaf", id: "leaf-a", tabs: [tabA], active: "tab-a" };
const leafB: LeafNode = { t: "leaf", id: "leaf-b", tabs: [tabB], active: "tab-b" };

const twoLeafTree: PaneNode = { t: "split", dir: "row", ratio: 0.5, a: leafA, b: leafB };

function renderTree(overrides?: { tree?: PaneNode; activePaneId?: string }) {
  usePaneStore.setState({
    tree: overrides?.tree ?? twoLeafTree,
    activePaneId: overrides?.activePaneId ?? "leaf-a",
  });
  return render(
    <PaneTree
      reindexing={false}
      deletedTabIds={new Set()}
      titleForTab={(noteId) => `Title ${noteId}`}
      onRequestClose={vi.fn()}
      onCloseOthers={vi.fn()}
      onCloseToRight={vi.fn()}
      onOpenRight={vi.fn()}
      onNewTab={vi.fn()}
    />,
  );
}

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // jsdom does not implement setPointerCapture / releasePointerCapture (TabStrip drag).
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("<PaneTree /> two-leaf render", () => {
  it("renders exactly two leaf-pane and two tab-strip nodes", () => {
    renderTree();
    expect(screen.getAllByTestId("leaf-pane")).toHaveLength(2);
    expect(screen.getAllByTestId("tab-strip")).toHaveLength(2);
  });

  it("the active leaf carries data-active-pane=true; the inactive leaf does not", () => {
    renderTree({ activePaneId: "leaf-a" });
    const leaves = screen.getAllByTestId("leaf-pane");
    const active = leaves.filter((el) => el.dataset.activePane === "true");
    const inactive = leaves.filter((el) => el.dataset.activePane === "false");
    expect(active).toHaveLength(1);
    expect(inactive).toHaveLength(1);
  });

  it("a split node renders a pane-divider between its two children", () => {
    renderTree();
    expect(screen.getByTestId("pane-divider")).toBeInTheDocument();
  });

  it("clicking an inactive leaf's chrome calls setActivePane with that leaf's id (D-04)", () => {
    renderTree({ activePaneId: "leaf-a" });
    const setActivePaneSpy = vi.spyOn(usePaneStore.getState(), "setActivePane");
    const leaves = screen.getAllByTestId("leaf-pane");
    const inactiveLeaf = leaves.find((el) => el.dataset.activePane === "false")!;
    expect(inactiveLeaf).toBeDefined();
    fireEvent.click(inactiveLeaf);
    expect(setActivePaneSpy).toHaveBeenCalledWith("leaf-b");
  });

  it("each leaf renders its own tab's EditorPane stub with the right noteId", () => {
    renderTree();
    const stubs = screen.getAllByTestId("editor-pane-stub");
    const noteIds = stubs.map((s) => s.dataset.noteId).sort();
    expect(noteIds).toEqual(["note-a", "note-b"]);
  });
});

describe("<PaneTree /> D-10 final-pane placeholder", () => {
  it("a leaf with zero tabs (active: null) renders without crashing, via EditorPane noteId=null", () => {
    const emptyLeaf: LeafNode = { t: "leaf", id: "leaf-empty", tabs: [], active: null };
    expect(() => renderTree({ tree: emptyLeaf, activePaneId: "leaf-empty" })).not.toThrow();
    expect(screen.getByTestId("leaf-pane")).toBeInTheDocument();
    const stub = screen.getByTestId("editor-pane-stub");
    expect(stub.dataset.noteId).toBe("null");
  });
});

describe("<PaneTree /> single-leaf render (no split)", () => {
  it("renders one leaf-pane and no pane-divider when the tree is a single leaf", () => {
    renderTree({ tree: leafA, activePaneId: "leaf-a" });
    expect(screen.getAllByTestId("leaf-pane")).toHaveLength(1);
    expect(screen.queryByTestId("pane-divider")).not.toBeInTheDocument();
  });
});
