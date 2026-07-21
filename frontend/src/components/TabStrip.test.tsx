/**
 * TabStrip tests:
 *   Task 1 — renders one pill per tab, wires select/close, overflow dropdown.
 *   Pointer drag — a non-threshold click still calls onSelectTab; no draggable attrs.
 *   TAB-11 — Alt+] calls onCycleTab(1); Alt+[ calls onCycleTab(-1);
 *            Ctrl+Tab / Ctrl+Shift+Tab cycle too. Ctrl+Tab preventDefault is guarded.
 *   TAB-05 — Alt+W requests close of the active tab; plain Ctrl+W does NOT.
 *   Phase 25 (25-06) — TabStrip is leaf-scoped: the keydown handler gates on
 *     usePaneStore.getState().activePaneId === leafId (Pitfall 3), so an
 *     inactive leaf's strip is a no-op for every shortcut.
 *
 * All timing is synchronous event dispatch — no sleeps, no fake timers needed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabStrip } from "./TabStrip";
import type { Tab } from "../lib/useTabStore";
import { useTreeStore } from "../lib/useTreeStore";
import { usePaneStore } from "../lib/usePaneStore";
import { usePaneDragStore } from "../lib/usePaneDragStore";

// TabStrip now calls useToast() (pinned-tab refuse-click toast, D-14) — stub
// it so every render site in this file doesn't need a real <ToastProvider>.
vi.mock("./toast.utils", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const tabs: Tab[] = [
  { id: "a", noteId: "a" },
  { id: "b", noteId: "b" },
  { id: "c", noteId: "c" },
];

const titleForTab = (noteId: string) => `Title ${noteId}`;

const LEAF_ID = "leaf-1";

interface Handlers {
  onSelectTab: ReturnType<typeof vi.fn>;
  onRequestClose: ReturnType<typeof vi.fn>;
  onCloseOthers: ReturnType<typeof vi.fn>;
  onCloseToRight: ReturnType<typeof vi.fn>;
  onCloseAll: ReturnType<typeof vi.fn>;
  onOpenRight: ReturnType<typeof vi.fn>;
  onTogglePin: ReturnType<typeof vi.fn>;
  onReorder: ReturnType<typeof vi.fn>;
  onNewTab: ReturnType<typeof vi.fn>;
  onCycleTab: ReturnType<typeof vi.fn>;
}

function renderStrip(overrides?: {
  leafId?: string;
  tabs?: Tab[];
  activeTabId?: string | null;
  deletedTabIds?: Set<string>;
  forceHiddenTabIds?: Set<string>;
}): Handlers {
  const handlers: Handlers = {
    onSelectTab: vi.fn(),
    onRequestClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseToRight: vi.fn(),
    onCloseAll: vi.fn(),
    onOpenRight: vi.fn(),
    onTogglePin: vi.fn(),
    onReorder: vi.fn(),
    onNewTab: vi.fn(),
    onCycleTab: vi.fn(),
  };
  render(
    <TabStrip
      leafId={overrides?.leafId ?? LEAF_ID}
      tabs={overrides?.tabs ?? tabs}
      activeTabId={overrides?.activeTabId ?? "a"}
      deletedTabIds={overrides?.deletedTabIds ?? new Set()}
      titleForTab={titleForTab}
      forceHiddenTabIds={overrides?.forceHiddenTabIds}
      {...handlers}
    />,
  );
  return handlers;
}

beforeEach(() => {
  cleanup();
  // The keydown handler gates on usePaneStore's activePaneId matching leafId
  // (Pitfall 3) — default to "this leaf is active" so existing shortcut
  // assertions exercise the acting path unless a test explicitly overrides it.
  usePaneStore.setState({ activePaneId: LEAF_ID });
  vi.restoreAllMocks();
  // jsdom does not implement setPointerCapture / releasePointerCapture.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("<TabStrip /> rendering (Task 1)", () => {
  it("renders one TabPill per tab and a tablist", () => {
    renderStrip();
    expect(screen.getByRole("tablist", { name: "Open tabs" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByText("Title a")).toBeInTheDocument();
    expect(screen.getByText("Title c")).toBeInTheDocument();
  });

  it("TAB-14: empty state renders the strip with the + new-tab button (not null)", () => {
    const onNewTab = vi.fn();
    render(
      <TabStrip
        leafId={LEAF_ID}
        tabs={[]}
        activeTabId={null}
        deletedTabIds={new Set()}
        titleForTab={titleForTab}
        onSelectTab={vi.fn()}
        onRequestClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseToRight={vi.fn()}
        onCloseAll={vi.fn()}
        onOpenRight={vi.fn()}
        onTogglePin={vi.fn()}
        onReorder={vi.fn()}
        onNewTab={onNewTab}
        onCycleTab={vi.fn()}
      />,
    );
    expect(screen.getByRole("tablist", { name: "Open tabs" })).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByTestId("new-tab-button")).toBeInTheDocument();
  });

  it("BUG 3c: empty-state new-tab button is tab-shaped (flush, square corners — not top-rounded)", () => {
    render(
      <TabStrip
        leafId={LEAF_ID}
        tabs={[]}
        activeTabId={null}
        deletedTabIds={new Set()}
        titleForTab={titleForTab}
        onSelectTab={vi.fn()}
        onRequestClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseToRight={vi.fn()}
        onCloseAll={vi.fn()}
        onOpenRight={vi.fn()}
        onTogglePin={vi.fn()}
        onReorder={vi.fn()}
        onNewTab={vi.fn()}
        onCycleTab={vi.fn()}
      />,
    );
    const btn = screen.getByTestId("new-tab-button");
    // Loose silhouette check: flush square corners like a restyled TabPill (TABUI-01).
    expect(btn.style.borderRadius).toBe("0");
  });

  it("TAB-14: clicking the + button in the empty state calls onNewTab once", () => {
    const onNewTab = vi.fn();
    render(
      <TabStrip
        leafId={LEAF_ID}
        tabs={[]}
        activeTabId={null}
        deletedTabIds={new Set()}
        titleForTab={titleForTab}
        onSelectTab={vi.fn()}
        onRequestClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseToRight={vi.fn()}
        onCloseAll={vi.fn()}
        onOpenRight={vi.fn()}
        onTogglePin={vi.fn()}
        onReorder={vi.fn()}
        onNewTab={onNewTab}
        onCycleTab={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("new-tab-button"));
    expect(onNewTab).toHaveBeenCalledTimes(1);
  });

  it("TAB-14: the + button also renders in the non-empty state", () => {
    renderStrip();
    expect(screen.getByTestId("new-tab-button")).toBeInTheDocument();
  });

  it("clicking a pill calls onSelectTab with that tab id", () => {
    const h = renderStrip();
    fireEvent.click(screen.getByText("Title b"));
    expect(h.onSelectTab).toHaveBeenCalledWith("b");
  });

  it("clicking the X close button routes through onRequestClose (flush-aware)", () => {
    const h = renderStrip();
    fireEvent.click(screen.getByRole("button", { name: "Close Title b" }));
    expect(h.onRequestClose).toHaveBeenCalledWith("b");
  });

  it("pointer drag: no draggable attributes on pill wrappers (native DnD removed)", () => {
    renderStrip();
    // After the pointer-event migration none of the tab pills should carry draggable=true.
    const pills = screen.getAllByRole("tab");
    for (const pill of pills) {
      expect(pill).not.toHaveAttribute("draggable", "true");
    }
  });

  it("pointer drag: a non-threshold click (pointerDown+Up at same x) still calls onSelectTab", () => {
    const h = renderStrip();
    const pillB = screen.getByText("Title b").closest('[role="tab"]')!;
    // The pill is rendered inside the wrapper div that carries the pointer handlers.
    const wrapper = pillB.closest("[data-tab-wrapper]") as HTMLElement;
    expect(wrapper).not.toBeNull();

    // Fire pointerDown at x=100, then pointerUp at same x — threshold NOT crossed.
    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    // Then the click fires (no drag was active, so no suppression).
    fireEvent.click(pillB);

    expect(h.onSelectTab).toHaveBeenCalledWith("b");
    // onReorder must NOT have been called because no threshold was crossed.
    expect(h.onReorder).not.toHaveBeenCalled();
  });

  it("TAB-17: jsdom escape hatch — clientWidth===0 hides nothing (all pills render)", () => {
    // jsdom reports clientWidth 0, so measure() bails and the pure overflow
    // function returns an empty set: every tab stays visible, no dropdown.
    renderStrip();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(
      screen.queryByRole("button", { name: "Show hidden tabs" }),
    ).not.toBeInTheDocument();
  });

  it("overflow dropdown renders when tabs are forced hidden; selecting calls onSelectTab", async () => {
    const user = userEvent.setup();
    const h = renderStrip({ forceHiddenTabIds: new Set(["c"]) });
    // Only 2 visible pills; the overflow trigger appears.
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    const trigger = screen.getByRole("button", { name: "Show hidden tabs" });
    expect(trigger).toBeInTheDocument();
    await user.click(trigger);
    const item = await screen.findByRole("menuitem", { name: /Title c/i });
    await user.click(item);
    await waitFor(() => expect(h.onSelectTab).toHaveBeenCalledWith("c"));
  });
});

describe("<TabStrip /> keyboard shortcuts (Task 2 — TAB-11 / TAB-05)", () => {
  it("TAB-11: Alt+] calls onCycleTab(1)", () => {
    const h = renderStrip();
    // macOS Option-key composition remaps Alt+] to key:"'" — dispatch the real
    // composed key alongside code:"BracketRight" to prove the handler reads e.code.
    fireEvent.keyDown(window, { code: "BracketRight", key: "'", altKey: true });
    expect(h.onCycleTab).toHaveBeenCalledWith(1);
  });

  it("TAB-11: Alt+[ calls onCycleTab(-1)", () => {
    const h = renderStrip({ activeTabId: "b" });
    fireEvent.keyDown(window, { code: "BracketLeft", key: "'", altKey: true });
    expect(h.onCycleTab).toHaveBeenCalledWith(-1);
  });

  it("TAB-11: Ctrl+Tab calls onCycleTab(1); Ctrl+Shift+Tab calls onCycleTab(-1)", () => {
    const h = renderStrip();
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(h.onCycleTab).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    expect(h.onCycleTab).toHaveBeenLastCalledWith(-1);
  });

  it("TAB-05: Alt+W calls onRequestClose with the active tab id", () => {
    const h = renderStrip({ activeTabId: "b" });
    // macOS Option-key composition remaps Alt+W to key:"∑" — dispatch the real
    // composed key alongside code:"KeyW" to prove the handler reads e.code.
    fireEvent.keyDown(window, { code: "KeyW", key: "∑", altKey: true });
    expect(h.onRequestClose).toHaveBeenCalledWith("b");
  });

  it("TAB-05: plain Ctrl+W does NOT trigger close (browser owns it)", () => {
    const h = renderStrip();
    fireEvent.keyDown(window, { code: "KeyW", key: "w", ctrlKey: true });
    expect(h.onRequestClose).not.toHaveBeenCalled();
  });

  it("no-op when there are zero tabs", () => {
    const h = renderStrip({ tabs: [], activeTabId: null });
    fireEvent.keyDown(window, { code: "BracketRight", key: "'", altKey: true });
    fireEvent.keyDown(window, { code: "KeyW", key: "∑", altKey: true });
    expect(h.onRequestClose).not.toHaveBeenCalled();
    expect(h.onCycleTab).not.toHaveBeenCalled();
  });

  it("Ctrl+Tab preventDefault is guarded — a non-cancelable event never throws", () => {
    const h = renderStrip();
    // A non-cancelable KeyboardEvent: preventDefault is a no-op but must not throw.
    const evt = new KeyboardEvent("keydown", {
      key: "Tab",
      ctrlKey: true,
      cancelable: false,
      bubbles: true,
    });
    expect(() => window.dispatchEvent(evt)).not.toThrow();
    expect(h.onCycleTab).toHaveBeenCalledWith(1);
  });
});

describe("<TabStrip /> active-pane gating (25-06 Task 1 — Pitfall 3 / T-25-06-Dup)", () => {
  it("Alt+W in a leaf that is NOT the active pane is a no-op", () => {
    usePaneStore.setState({ activePaneId: "some-other-leaf" });
    const h = renderStrip({ activeTabId: "b" });
    fireEvent.keyDown(window, { code: "KeyW", key: "∑", altKey: true });
    expect(h.onRequestClose).not.toHaveBeenCalled();
  });

  it("Alt+]/Ctrl+Tab cycle shortcuts in an inactive leaf are no-ops", () => {
    usePaneStore.setState({ activePaneId: "some-other-leaf" });
    const h = renderStrip();
    fireEvent.keyDown(window, { code: "BracketRight", key: "'", altKey: true });
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(h.onCycleTab).not.toHaveBeenCalled();
  });

  it("Alt+W in the active leaf still closes (contrast case, same test proves the gate is a real guard not a global no-op)", () => {
    usePaneStore.setState({ activePaneId: LEAF_ID });
    const h = renderStrip({ activeTabId: "b" });
    fireEvent.keyDown(window, { code: "KeyW", key: "∑", altKey: true });
    expect(h.onRequestClose).toHaveBeenCalledWith("b");
  });
});

describe("<TabStrip /> ghost drag (MTR ghost + dim)", () => {
  it("pointerDown + pointerMove past threshold renders tab-drag-ghost", () => {
    renderStrip();
    const strip = screen.getByRole("tablist");
    const wrapper = screen.getByText("Title b").closest("[data-tab-wrapper]") as HTMLElement;
    expect(wrapper).not.toBeNull();

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 120, pointerId: 1, buttons: 1 });

    expect(screen.getByTestId("tab-drag-ghost")).toBeInTheDocument();
  });

  it("pointerUp removes the ghost (count 0 after release)", () => {
    renderStrip();
    const strip = screen.getByRole("tablist");
    const wrapper = screen.getByText("Title b").closest("[data-tab-wrapper]") as HTMLElement;

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 120, pointerId: 1, buttons: 1 });
    expect(screen.getByTestId("tab-drag-ghost")).toBeInTheDocument();

    fireEvent.pointerUp(strip, { button: 0, clientX: 120, pointerId: 1 });
    expect(screen.queryByTestId("tab-drag-ghost")).not.toBeInTheDocument();
  });

  it("a second pointerMove updates the ghost position without throwing", () => {
    renderStrip();
    const strip = screen.getByRole("tablist");
    const wrapper = screen.getByText("Title b").closest("[data-tab-wrapper]") as HTMLElement;

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 120, pointerId: 1, buttons: 1 });
    expect(() => {
      fireEvent.pointerMove(strip, { clientX: 140, pointerId: 1, buttons: 1 });
    }).not.toThrow();
    expect(screen.getByTestId("tab-drag-ghost")).toBeInTheDocument();
  });

  it("pointerCancel removes the ghost (no stranded ghost)", () => {
    renderStrip();
    const strip = screen.getByRole("tablist");
    const wrapper = screen.getByText("Title b").closest("[data-tab-wrapper]") as HTMLElement;

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 120, pointerId: 1, buttons: 1 });
    expect(screen.getByTestId("tab-drag-ghost")).toBeInTheDocument();

    fireEvent.pointerCancel(strip, { clientX: 120, pointerId: 1 });
    expect(screen.queryByTestId("tab-drag-ghost")).not.toBeInTheDocument();
  });

  it("below-threshold move does NOT render the ghost", () => {
    renderStrip();
    const strip = screen.getByRole("tablist");
    const wrapper = screen.getByText("Title b").closest("[data-tab-wrapper]") as HTMLElement;

    // Move only 3px — below the 5px threshold
    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 103, pointerId: 1, buttons: 1 });

    expect(screen.queryByTestId("tab-drag-ghost")).not.toBeInTheDocument();
  });

  it("POLISH-GHOST: ghost renders a real TabPill with a visible Close button", () => {
    // Drag tab `a` (the default active tab in renderStrip).
    renderStrip();
    const strip = screen.getByRole("tablist");
    const wrapper = screen.getByText("Title a").closest("[data-tab-wrapper]") as HTMLElement;
    expect(wrapper).not.toBeNull();

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 120, pointerId: 1, buttons: 1 });

    const ghost = screen.getByTestId("tab-drag-ghost");
    expect(ghost).toBeInTheDocument();
    // A real TabPill always renders an aria-labelled Close button — a title-only
    // lightweight ghost would not have this element.
    // { hidden: true } because the ghost container carries aria-hidden="true" (it's a
    // visual decoration); we still want to assert the Close button is physically present.
    expect(within(ghost).getByRole("button", { name: /^Close/, hidden: true })).toBeInTheDocument();
  });

  it("gap 5 / CR-02: an off-strip release (buttons:0 move) dismisses the drag and does not swallow the next click", () => {
    const h = renderStrip();
    const strip = screen.getByRole("tablist");
    const wrapper = screen.getByText("Title b").closest("[data-tab-wrapper]") as HTMLElement;

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 120, pointerId: 1, buttons: 1 });
    expect(screen.getByTestId("tab-drag-ghost")).toBeInTheDocument();

    // The mouse button was released outside the strip, so no pointerup ever
    // reaches the strip — but the next pointermove reports buttons:0.
    fireEvent.pointerMove(strip, { clientX: 130, pointerId: 1, buttons: 0 });
    expect(screen.queryByTestId("tab-drag-ghost")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tab-drop-indicator")).not.toBeInTheDocument();

    // A subsequent legitimate click must not be swallowed by a stale suppressClickRef.
    fireEvent.click(screen.getByText("Title a"));
    expect(h.onSelectTab).toHaveBeenCalledWith("a");
  });

  it("POLISH-OVERLAY: drop indicator is position:absolute and not inside any tab wrapper", () => {
    renderStrip();
    const strip = screen.getByRole("tablist");
    const wrapper = screen.getByText("Title b").closest("[data-tab-wrapper]") as HTMLElement;
    expect(wrapper).not.toBeNull();

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 120, pointerId: 1, buttons: 1 });

    const indicator = screen.getByTestId("tab-drop-indicator");
    expect(indicator).toBeInTheDocument();
    // jsdom reflects inline styles in getComputedStyle — verifies the overlay approach.
    expect(getComputedStyle(indicator).position).toBe("absolute");
    // The indicator must be a strip-level child, not inside any tab wrapper
    // (it is an overlay, not an inline flex-child that would shift other pills).
    expect(indicator.closest("[data-tab-wrapper]")).toBeNull();
  });

  it("CR-01: elementFromPoint resolving back to the drag's own source leaf does not publish a self-hover", () => {
    const handlers = {
      onSelectTab: vi.fn(),
      onRequestClose: vi.fn(),
      onCloseOthers: vi.fn(),
      onCloseToRight: vi.fn(),
      onCloseAll: vi.fn(),
      onOpenRight: vi.fn(),
      onTogglePin: vi.fn(),
      onReorder: vi.fn(),
      onNewTab: vi.fn(),
      onCycleTab: vi.fn(),
    };
    // Mirror LeafPane's real DOM shape: TabStrip is nested inside its own
    // pane's `[data-droppane]` wrapper (LeafPane.tsx:296).
    render(
      <div data-droppane={LEAF_ID}>
        <TabStrip
          leafId={LEAF_ID}
          tabs={tabs}
          activeTabId="a"
          deletedTabIds={new Set()}
          titleForTab={titleForTab}
          {...handlers}
        />
      </div>,
    );
    const strip = screen.getByRole("tablist");
    const wrapper = screen.getByText("Title b").closest("[data-tab-wrapper]") as HTMLElement;

    // Real browsers: during an ordinary in-strip reorder, elementFromPoint
    // resolves back into THIS leaf's own subtree (cursor never left the
    // pane). jsdom does not implement elementFromPoint at all (the source
    // feature-detects it away, TabStrip.tsx:485), so define it before spying.
    document.elementFromPoint = () => null;
    vi.spyOn(document, "elementFromPoint").mockReturnValue(strip);

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 120, clientY: 10, pointerId: 1, buttons: 1 });

    expect(usePaneDragStore.getState().hover).toBeNull();
  });
});

describe("<TabStrip /> right-hand cluster (Plan 18-02 — relocated per D-04)", () => {
  beforeEach(() => {
    useTreeStore.setState({
      notesSidebarVisible: true,
      backlinksRailExpanded: true,
    });
  });

  it("shows aria-label 'Hide panels' when backlinksRailExpanded is true", () => {
    useTreeStore.setState({ backlinksRailExpanded: true });
    renderStrip();
    expect(screen.getByRole("button", { name: "Hide panels" })).toBeInTheDocument();
  });

  it("shows aria-label 'Show panels' when backlinksRailExpanded is false", () => {
    useTreeStore.setState({ backlinksRailExpanded: false });
    renderStrip();
    expect(screen.getByRole("button", { name: "Show panels" })).toBeInTheDocument();
  });

  it("clicking the right toggle calls setBacklinksRailExpanded(!backlinksRailExpanded)", () => {
    useTreeStore.setState({ backlinksRailExpanded: true });
    renderStrip();
    fireEvent.click(screen.getByRole("button", { name: "Hide panels" }));
    expect(useTreeStore.getState().backlinksRailExpanded).toBe(false);
  });

  // Phase 27 NAV-03 cleanup: the redundant left-sidebar toggle was removed from
  // the tab strip — the sidebar collapses from its own header (SidebarTabRow)
  // and reopens via PaneCornerReopenButton. The tab strip must NOT carry a
  // left-sidebar toggle in EITHER state.
  it("NAV-03: no left-sidebar toggle in the tab strip when the sidebar is OPEN", () => {
    useTreeStore.setState({ notesSidebarVisible: true });
    renderStrip();
    expect(
      screen.queryByRole("button", { name: "Hide notes sidebar" }),
    ).toBeNull();
    expect(screen.queryByTestId("tab-strip-left-cluster")).toBeNull();
  });

  it("NAV-03: no left-sidebar toggle in the tab strip when the sidebar is CLOSED", () => {
    useTreeStore.setState({ notesSidebarVisible: false });
    renderStrip();
    expect(
      screen.queryByRole("button", { name: "Show notes sidebar" }),
    ).toBeNull();
    expect(screen.queryByTestId("tab-strip-left-cluster")).toBeNull();
  });

  it("SPLIT-PLACEMENT: right-sidebar toggle is inside tab-strip-right-cluster", () => {
    renderStrip();
    const rightCluster = screen.getByTestId("tab-strip-right-cluster");
    expect(
      within(rightCluster).getByRole("button", { name: "Hide panels" }),
    ).toBeInTheDocument();
  });

  // D-04: the old chrome wrapper gated the right-rail toggle behind the
  // now-retired panel-selector slice (TBR-N3-3/4a/4b, RR-T-1). That gate was
  // intentionally dropped — the right toggle is ALWAYS rendered, and the
  // panel-selector slice itself was fully removed in Phase 20 (D-01).
  it("D-04: right-rail toggle is ALWAYS rendered (no gating condition)", () => {
    renderStrip();
    expect(
      screen.queryByRole("button", { name: /hide panels|show panels/i }),
    ).not.toBeNull();
  });

  it("right cluster is present in the zero-tab empty state (no left cluster)", () => {
    render(
      <TabStrip
        leafId={LEAF_ID}
        tabs={[]}
        activeTabId={null}
        deletedTabIds={new Set()}
        titleForTab={titleForTab}
        onSelectTab={vi.fn()}
        onRequestClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseToRight={vi.fn()}
        onCloseAll={vi.fn()}
        onOpenRight={vi.fn()}
        onTogglePin={vi.fn()}
        onReorder={vi.fn()}
        onNewTab={vi.fn()}
        onCycleTab={vi.fn()}
      />,
    );
    expect(screen.getByTestId("tab-strip-right-cluster")).toBeInTheDocument();
    expect(screen.queryByTestId("tab-strip-left-cluster")).toBeNull();
  });
});

describe("<TabStrip /> collapsed-sidebar reopen cell (Phase 27 NAV-03)", () => {
  const baseProps = {
    leafId: LEAF_ID,
    tabs: [] as Tab[],
    activeTabId: null,
    deletedTabIds: new Set<string>(),
    titleForTab,
    onSelectTab: vi.fn(),
    onRequestClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseToRight: vi.fn(),
    onCloseAll: vi.fn(),
    onOpenRight: vi.fn(),
    onTogglePin: vi.fn(),
    onReorder: vi.fn(),
    onNewTab: vi.fn(),
    onCycleTab: vi.fn(),
  };

  it("shows the reopen cell on the top-left leaf when the sidebar is COLLAPSED", () => {
    useTreeStore.setState({ notesSidebarVisible: false });
    render(<TabStrip {...baseProps} isTopLeftLeaf />);
    expect(
      screen.getByRole("button", { name: "Show sidebar" }),
    ).toBeInTheDocument();
  });

  it("hides the reopen cell on the top-left leaf when the sidebar is OPEN", () => {
    useTreeStore.setState({ notesSidebarVisible: true });
    render(<TabStrip {...baseProps} isTopLeftLeaf />);
    expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();
  });

  it("never shows the reopen cell on a non-top-left leaf, even when collapsed", () => {
    useTreeStore.setState({ notesSidebarVisible: false });
    render(<TabStrip {...baseProps} isTopLeftLeaf={false} />);
    expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();
  });
});
