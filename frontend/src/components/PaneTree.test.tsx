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
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { PaneTree } from "./PaneTree";
import { usePaneStore } from "../lib/usePaneStore";
import { useTreeStore } from "../lib/useTreeStore";

// PaneTree nests TabStrip, which now calls useToast() (D-14 pinned refuse
// toast) — stub it so no render site here needs a real <ToastProvider>.
vi.mock("./toast.utils", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
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
      onCloseAll={vi.fn()}
      onOpenRight={vi.fn()}
      onTogglePin={vi.fn()}
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
  useTreeStore.setState({ notesSidebarVisible: true, backlinksRailExpanded: true });
});

describe("<PaneTree /> pane-corner reopen button (Phase 27 D-12)", () => {
  it("with a 2-leaf split + collapsed sidebar, exactly one 'Show sidebar' button renders (top-left leaf only)", () => {
    useTreeStore.setState({ notesSidebarVisible: false });
    renderTree();
    expect(screen.getAllByRole("button", { name: "Show sidebar" })).toHaveLength(1);
  });

  it("renders zero reopen buttons when notesSidebarVisible is true", () => {
    useTreeStore.setState({ notesSidebarVisible: true });
    renderTree();
    expect(screen.queryAllByRole("button", { name: "Show sidebar" })).toHaveLength(0);
  });
});

describe("<PaneTree /> right-rail reopen toggle threading (260721-cjt)", () => {
  it("single-leaf tree: the sole leaf's strip is the rightmost — gets the collapsed toggle when the rail is collapsed", () => {
    useTreeStore.setState({ backlinksRailExpanded: false });
    renderTree({ tree: leafA, activePaneId: "leaf-a" });
    expect(screen.getAllByTestId("tab-strip-right-cluster")).toHaveLength(1);
  });

  it("row-split tree: exactly ONE strip (the pre-order-last leaf) carries tab-strip-right-cluster when the rail is collapsed", () => {
    useTreeStore.setState({ backlinksRailExpanded: false });
    renderTree();
    expect(screen.getAllByTestId("tab-strip-right-cluster")).toHaveLength(1);
  });

  it("row-split tree: no strip carries tab-strip-right-cluster when the rail is expanded", () => {
    useTreeStore.setState({ backlinksRailExpanded: true });
    renderTree();
    expect(screen.queryAllByTestId("tab-strip-right-cluster")).toHaveLength(0);
  });
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

  it("D-27/D-28: in a two-leaf split, the active leaf carries the inset accent box-shadow and the inactive one does not", () => {
    renderTree({ activePaneId: "leaf-a" });
    const leaves = screen.getAllByTestId("leaf-pane");
    const active = leaves.find((el) => el.dataset.activePane === "true")!;
    const inactive = leaves.find((el) => el.dataset.activePane === "false")!;
    expect(active.style.boxShadow).toContain("inset 0 0 0 1px");
    expect(inactive.style.boxShadow).toBe("");
  });
});

describe("<PaneTree /> divider accessibility (WR-01) and text-selection guard (WR-02)", () => {
  it("WR-01: divider handle exposes role=separator, orientation, and the current ratio as aria-valuenow", () => {
    renderTree(); // twoLeafTree: dir "row", ratio 0.5
    const handle = screen.getByTestId("pane-divider-handle");
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("50");
    expect(handle.getAttribute("aria-valuemin")).toBe("0");
    expect(handle.getAttribute("aria-valuemax")).toBe("100");
    // D-15 (locked): pointer-drag only, no keyboard resize — deliberately
    // NOT in the tab order (a focusable separator with no arrow-key support
    // would be a worse a11y experience than one that's absent from Tab order
    // but still announced to a screen reader's browse-mode cursor).
    expect(handle.getAttribute("tabindex")).toBeNull();
  });

  it("WR-01: the pane-divider wrapper is no longer aria-hidden", () => {
    renderTree();
    expect(screen.getByTestId("pane-divider").getAttribute("aria-hidden")).toBeNull();
  });

  it("WR-02: pointerdown on the divider clears any accumulated text selection", () => {
    renderTree();
    const removeAllRanges = vi.fn();
    vi.spyOn(window, "getSelection").mockReturnValue({
      removeAllRanges,
    } as unknown as Selection);

    fireEvent.pointerDown(screen.getByTestId("pane-divider-handle"), {
      button: 0,
      clientX: 100,
      clientY: 50,
    });

    expect(removeAllRanges).toHaveBeenCalled();
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

  it("D-27/D-28: a single-pane layout shows no active-pane inset cue, even though it is trivially active", () => {
    renderTree({ tree: leafA, activePaneId: "leaf-a" });
    const leaf = screen.getByTestId("leaf-pane");
    expect(leaf.dataset.activePane).toBe("true");
    expect(leaf.style.boxShadow).toBe("");
  });
});

describe("<PaneTree /> CR-01 regression (25-REVIEW.md): unrelated sibling survives a further split", () => {
  it("splitting leaf-a does NOT remount leaf-b's EditorPane (no content-derived split-node key)", () => {
    renderTree({ tree: twoLeafTree, activePaneId: "leaf-a" });

    const stubsBefore = screen.getAllByTestId("editor-pane-stub");
    const leafBStubBefore = stubsBefore.find((el) => el.dataset.noteId === "note-b");
    expect(leafBStubBefore).toBeDefined();

    // Split the OTHER leaf (leaf-a, the active pane) — leaf-b is completely
    // uninvolved in this operation. This is exactly the CR-01 trigger: a
    // child transitioning leaf -> split.
    act(() => {
      usePaneStore.getState().splitActivePane("row");
    });

    // The tree now has 3 leaves (leaf-a split into two; leaf-b untouched).
    expect(screen.getAllByTestId("leaf-pane")).toHaveLength(3);

    const stubsAfter = screen.getAllByTestId("editor-pane-stub");
    const leafBStubAfter = stubsAfter.find((el) => el.dataset.noteId === "note-b");
    expect(leafBStubAfter).toBeDefined();

    // Before the CR-01 fix, the split-node wrapper's content-derived key
    // (`` `${a-is-leaf?}|${b-is-leaf?}` ``) flipped from "leafA|leafB" to
    // "split|leafB" the moment leaf-a became a split node — forcing React to
    // unmount + remount the ENTIRE outer subtree, including the untouched
    // leaf-b, producing a brand-new DOM node (and, in the real app, a fresh
    // shared-doc-registry registration / lost CM6 view+cursor+undo for
    // leaf-b). With no content-derived key, React reconciles the wrapper in
    // place and leaf-b's EditorPane survives as the SAME DOM node.
    expect(leafBStubAfter).toBe(leafBStubBefore);
  });
});
