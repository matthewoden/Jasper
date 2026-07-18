/**
 * LeafPane tests (Phase 26 Plan 02 Task 2):
 *   - The root renders `data-droppane={leaf.id}` so TabStrip's cross-pane
 *     `elementFromPoint` hit-testing resolves this leaf (WS-01/WS-02).
 *   - The translucent drop-region overlay (D-10) renders ONLY while a drag
 *     is active AND usePaneDragStore's hover targets THIS leaf; it renders
 *     nothing for a different leaf's hover, and nothing when no drag is
 *     active at all.
 *   - Overlay geometry matches UI-SPEC per region (half-pane for split
 *     regions, full-pane inset:0 for center) and never intercepts pointer
 *     events.
 *
 * `EditorPane` is mocked to a lightweight stub, mirroring PaneTree.test.tsx —
 * this suite exercises LeafPane's own drop-target/overlay wiring, not the
 * full editor stack.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LeafPane } from "./LeafPane";
import { usePaneDragStore } from "../lib/usePaneDragStore";
import type { LeafNode } from "../lib/paneTree";
import type { Tab } from "../lib/useTabStore";

vi.mock("./EditorPane", () => ({
  EditorPane: ({ noteId }: { noteId: string | null }) => (
    <div data-testid="editor-pane-stub" data-note-id={noteId ?? "null"} />
  ),
}));

const tabA: Tab = { id: "tab-a", noteId: "note-a" };
const leafA: LeafNode = { t: "leaf", id: "leaf-a", tabs: [tabA], active: "tab-a" };

function renderLeaf(leaf: LeafNode = leafA) {
  return render(
    <LeafPane
      leaf={leaf}
      isActive={true}
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
  usePaneDragStore.setState({ activeDrag: null, hover: null });
});

describe("<LeafPane /> data-droppane (WS-01/WS-02 hit-testing)", () => {
  it("the root carries data-droppane set to the leaf id", () => {
    renderLeaf();
    expect(screen.getByTestId("leaf-pane").dataset.droppane).toBe("leaf-a");
  });
});

describe("<LeafPane /> drop-region overlay (D-10)", () => {
  it("renders nothing when no drag is active", () => {
    renderLeaf();
    expect(screen.queryByTestId("drop-overlay")).not.toBeInTheDocument();
  });

  it("renders nothing when a drag is active but hovering a DIFFERENT leaf", () => {
    usePaneDragStore.setState({
      activeDrag: { sourceLeafId: "leaf-a", tabId: "tab-a" },
      hover: { leafId: "leaf-other", region: "center" },
    });
    renderLeaf();
    expect(screen.queryByTestId("drop-overlay")).not.toBeInTheDocument();
  });

  it("renders the overlay when the drag hovers THIS leaf, with the matching data-drop-region", () => {
    usePaneDragStore.setState({
      activeDrag: { sourceLeafId: "leaf-other", tabId: "tab-x" },
      hover: { leafId: "leaf-a", region: "right" },
    });
    renderLeaf();
    const overlay = screen.getByTestId("drop-overlay");
    expect(overlay.dataset.dropRegion).toBe("right");
  });

  it("center region overlay covers the full pane (inset:0) and never intercepts pointer events", () => {
    usePaneDragStore.setState({
      activeDrag: { sourceLeafId: "leaf-other", tabId: "tab-x" },
      hover: { leafId: "leaf-a", region: "center" },
    });
    renderLeaf();
    const overlay = screen.getByTestId("drop-overlay");
    expect(overlay.style.inset).toBe("0");
    expect(overlay.style.pointerEvents).toBe("none");
  });

  it("left region overlay pins a 50% width half-pane strip", () => {
    usePaneDragStore.setState({
      activeDrag: { sourceLeafId: "leaf-other", tabId: "tab-x" },
      hover: { leafId: "leaf-a", region: "left" },
    });
    renderLeaf();
    const overlay = screen.getByTestId("drop-overlay");
    expect(overlay.style.width).toBe("50%");
    expect(overlay.style.left).toBe("0px");
  });

  it("uses the UI-SPEC accent fill and border color-mix tokens", () => {
    usePaneDragStore.setState({
      activeDrag: { sourceLeafId: "leaf-other", tabId: "tab-x" },
      hover: { leafId: "leaf-a", region: "top" },
    });
    renderLeaf();
    const overlay = screen.getByTestId("drop-overlay");
    expect(overlay.style.background).toContain("color-mix(in srgb, var(--color-accent) 18%, transparent)");
    expect(overlay.style.border).toContain("color-mix(in srgb, var(--color-accent) 60%, transparent)");
  });
});
