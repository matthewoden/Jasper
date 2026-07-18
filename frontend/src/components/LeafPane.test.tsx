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
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { LeafPane } from "./LeafPane";
import { usePaneDragStore } from "../lib/usePaneDragStore";
import type { LeafNode } from "../lib/paneTree";
import type { Tab } from "../lib/useTabStore";

// CR-03 needs each mocked EditorPane to expose a controllable
// EditorPaneHandlers instance (per noteId, stable across re-renders so a
// mock's call history survives a tab-switch rerender) and a way to trigger
// onOpenFind — vi.hoisted so the mock factory below (which vitest hoists
// above imports) can close over it.
const { handleFor, handlesByNoteId } = vi.hoisted(() => {
  const handlesByNoteId = new Map<
    string,
    {
      setSearchQuery: ReturnType<typeof vi.fn>;
      matchInfo: () => { current: number; total: number };
      findNext: ReturnType<typeof vi.fn>;
      findPrevious: ReturnType<typeof vi.fn>;
      replaceNext: ReturnType<typeof vi.fn>;
      replaceAll: ReturnType<typeof vi.fn>;
      clearSearch: ReturnType<typeof vi.fn>;
      focus: ReturnType<typeof vi.fn>;
    }
  >();
  function handleFor(noteId: string) {
    let h = handlesByNoteId.get(noteId);
    if (!h) {
      h = {
        setSearchQuery: vi.fn(),
        matchInfo: () => ({ current: 0, total: 0 }),
        findNext: vi.fn(),
        findPrevious: vi.fn(),
        replaceNext: vi.fn(),
        replaceAll: vi.fn(),
        clearSearch: vi.fn(),
        focus: vi.fn(),
      };
      handlesByNoteId.set(noteId, h);
    }
    return h;
  }
  return { handleFor, handlesByNoteId };
});

vi.mock("./EditorPane", () => ({
  EditorPane: ({
    noteId,
    editorHandlersRef,
    onOpenFind,
    findBarSlot,
  }: {
    noteId: string | null;
    editorHandlersRef?: { current: unknown };
    onOpenFind?: () => void;
    findBarSlot?: React.ReactNode;
  }) => {
    if (noteId && editorHandlersRef) {
      editorHandlersRef.current = handleFor(noteId);
    }
    return (
      <div data-testid="editor-pane-stub" data-note-id={noteId ?? "null"}>
        {onOpenFind && (
          <button type="button" data-testid={`open-find-${noteId}`} onClick={onOpenFind}>
            open find
          </button>
        )}
        {findBarSlot}
      </div>
    );
  },
}));

const tabA: Tab = { id: "tab-a", noteId: "note-a" };
const leafA: LeafNode = { t: "leaf", id: "leaf-a", tabs: [tabA], active: "tab-a" };

function renderLeaf(leaf: LeafNode = leafA, overrides?: { isActive?: boolean }) {
  return render(
    <LeafPane
      leaf={leaf}
      isActive={overrides?.isActive ?? true}
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
  handlesByNoteId.clear();
});

describe("<LeafPane /> data-droppane (WS-01/WS-02 hit-testing)", () => {
  it("the root carries data-droppane set to the leaf id", () => {
    renderLeaf();
    expect(screen.getByTestId("leaf-pane").dataset.droppane).toBe("leaf-a");
  });
});

describe("<LeafPane /> no inactive-pane dim (readability)", () => {
  it("an inactive pane's root carries no opacity dim", () => {
    renderLeaf(leafA, { isActive: false });
    const root = screen.getByTestId("leaf-pane");
    const opacity = root.style.opacity;
    expect(opacity === "" || opacity === "1").toBe(true);
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

describe("<LeafPane /> Find/Replace bar re-syncs on active-tab change (CR-03)", () => {
  const tabB: Tab = { id: "tab-b", noteId: "note-b" };
  const twoTabLeaf: LeafNode = { t: "leaf", id: "leaf-a", tabs: [tabA, tabB], active: "tab-a" };

  it("re-applies the open bar's current query to the tab that just became active", () => {
    const { rerender } = renderLeaf(twoTabLeaf);

    fireEvent.click(screen.getByTestId("open-find-note-a"));
    // getByPlaceholderText, not getByLabelText: the query input's own
    // aria-label="Find" collides with the surrounding role="search"
    // container's aria-label="Find" (FindReplaceBar.tsx:240).
    fireEvent.change(screen.getByPlaceholderText("Find"), { target: { value: "hello" } });

    const handleA = handleFor("note-a");
    const handleB = handleFor("note-b");
    expect(handleA.setSearchQuery).toHaveBeenCalledTimes(1);
    // Before the fix, switching the active tab never called syncQuery again —
    // the newly active tab's EditorView kept no SearchQuery at all.
    expect(handleB.setSearchQuery).not.toHaveBeenCalled();

    // Mirrors what the real app does on Alt+]/Ctrl+Tab/tab-pill click: the
    // parent re-renders LeafPane with `leaf.active` pointing at the new tab.
    rerender(
      <LeafPane
        leaf={{ ...twoTabLeaf, active: "tab-b" }}
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

    expect(handleB.setSearchQuery).toHaveBeenCalledTimes(1);
    const appliedQuery = handleB.setSearchQuery.mock.calls[0][0] as { search: string };
    expect(appliedQuery.search).toBe("hello");
  });

  it("does not re-sync when the bar is closed (no stray SearchQuery pushed on tab switch)", () => {
    const { rerender } = renderLeaf(twoTabLeaf);
    // Bar never opened — findBar.open stays false throughout.

    rerender(
      <LeafPane
        leaf={{ ...twoTabLeaf, active: "tab-b" }}
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

    expect(handleFor("note-a").setSearchQuery).not.toHaveBeenCalled();
    expect(handleFor("note-b").setSearchQuery).not.toHaveBeenCalled();
  });
});

describe("<LeafPane /> Find bar renders inside the active EditorPane (P26 polish, UI-SPEC line 151)", () => {
  it("the find bar is a DESCENDANT of the active tab's editor-pane-stub, not a LeafPane-level sibling above it", () => {
    renderLeaf();

    // Before opening find, nothing to find at all.
    expect(screen.queryByTestId("find-bar")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("open-find-note-a"));

    const activeStub = screen.getByTestId("editor-pane-stub");
    // Resolves via `within` — proves the bar is a DOM descendant of the
    // stub (i.e. was passed through findBarSlot into EditorPane), not a
    // sibling rendered above it at the LeafPane level (the pre-fix DOM
    // order: FindReplaceBar between TabStrip and the EditorPane stack).
    expect(within(activeStub).getByTestId("find-bar")).toBeInTheDocument();

    // A direct query against the LeafPane root would ALSO find it (it's
    // still in the document), but compareDocumentPosition confirms the bar
    // is nested INSIDE the stub, not a preceding sibling of it.
    const bar = screen.getByTestId("find-bar");
    expect(activeStub.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
  });
});
