/**
 * TabStrip tests:
 *   Task 1 — renders one pill per tab, wires select/close, overflow dropdown.
 *   Pointer drag — a non-threshold click still calls onSelectTab; no draggable attrs.
 *   TAB-11 — Alt+] cycles next (cycleTab(1)); Alt+[ cycles previous (cycleTab(-1));
 *            Ctrl+Tab / Ctrl+Shift+Tab cycle too. Ctrl+Tab preventDefault is guarded.
 *   TAB-05 — Alt+W requests close of the active tab; plain Ctrl+W does NOT.
 *
 * All timing is synchronous event dispatch — no sleeps, no fake timers needed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabStrip } from "./TabStrip";
import { useTabStore } from "../lib/useTabStore";
import type { Tab } from "../lib/useTabStore";
import { useTreeStore } from "../lib/useTreeStore";

const tabs: Tab[] = [
  { id: "a", noteId: "a" },
  { id: "b", noteId: "b" },
  { id: "c", noteId: "c" },
];

const titleForTab = (noteId: string) => `Title ${noteId}`;

interface Handlers {
  onSelectTab: ReturnType<typeof vi.fn>;
  onRequestClose: ReturnType<typeof vi.fn>;
  onCloseOthers: ReturnType<typeof vi.fn>;
  onCloseToRight: ReturnType<typeof vi.fn>;
  onOpenRight: ReturnType<typeof vi.fn>;
  onReorder: ReturnType<typeof vi.fn>;
  onNewTab: ReturnType<typeof vi.fn>;
}

function renderStrip(overrides?: {
  activeTabId?: string | null;
  deletedTabIds?: Set<string>;
  forceHiddenTabIds?: Set<string>;
}): Handlers {
  const handlers: Handlers = {
    onSelectTab: vi.fn(),
    onRequestClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseToRight: vi.fn(),
    onOpenRight: vi.fn(),
    onReorder: vi.fn(),
    onNewTab: vi.fn(),
  };
  render(
    <TabStrip
      tabs={tabs}
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
  // The keyboard handler reads live store state — keep it in sync with the props.
  useTabStore.setState({ tabs, activeTabId: "a", deletedTabIds: new Set() });
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
        tabs={[]}
        activeTabId={null}
        deletedTabIds={new Set()}
        titleForTab={titleForTab}
        onSelectTab={vi.fn()}
        onRequestClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseToRight={vi.fn()}
        onOpenRight={vi.fn()}
        onReorder={vi.fn()}
        onNewTab={onNewTab}
      />,
    );
    expect(screen.getByRole("tablist", { name: "Open tabs" })).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByTestId("new-tab-button")).toBeInTheDocument();
  });

  it("BUG 3c: empty-state new-tab button is tab-shaped (flush, square corners — not top-rounded)", () => {
    render(
      <TabStrip
        tabs={[]}
        activeTabId={null}
        deletedTabIds={new Set()}
        titleForTab={titleForTab}
        onSelectTab={vi.fn()}
        onRequestClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseToRight={vi.fn()}
        onOpenRight={vi.fn()}
        onReorder={vi.fn()}
        onNewTab={vi.fn()}
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
        tabs={[]}
        activeTabId={null}
        deletedTabIds={new Set()}
        titleForTab={titleForTab}
        onSelectTab={vi.fn()}
        onRequestClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseToRight={vi.fn()}
        onOpenRight={vi.fn()}
        onReorder={vi.fn()}
        onNewTab={onNewTab}
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
  it("TAB-11: Alt+] advances the active tab (cycleTab(1))", () => {
    renderStrip();
    expect(useTabStore.getState().activeTabId).toBe("a");
    // macOS Option-key composition remaps Alt+] to key:"'" — dispatch the real
    // composed key alongside code:"BracketRight" to prove the handler reads e.code.
    fireEvent.keyDown(window, { code: "BracketRight", key: "'", altKey: true });
    expect(useTabStore.getState().activeTabId).toBe("b");
  });

  it("TAB-11: Alt+[ moves to the previous tab (cycleTab(-1))", () => {
    useTabStore.setState({ activeTabId: "b" });
    renderStrip({ activeTabId: "b" });
    fireEvent.keyDown(window, { code: "BracketLeft", key: "'", altKey: true });
    expect(useTabStore.getState().activeTabId).toBe("a");
  });

  it("TAB-11: Ctrl+Tab advances; Ctrl+Shift+Tab goes back", () => {
    renderStrip();
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(useTabStore.getState().activeTabId).toBe("b");
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    expect(useTabStore.getState().activeTabId).toBe("a");
  });

  it("TAB-05: Alt+W calls onRequestClose with the active tab id", () => {
    const h = renderStrip({ activeTabId: "b" });
    useTabStore.setState({ activeTabId: "b" });
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
    useTabStore.setState({ tabs: [], activeTabId: null });
    const h = renderStrip();
    fireEvent.keyDown(window, { code: "BracketRight", key: "'", altKey: true });
    fireEvent.keyDown(window, { code: "KeyW", key: "∑", altKey: true });
    expect(h.onRequestClose).not.toHaveBeenCalled();
  });

  it("Ctrl+Tab preventDefault is guarded — a non-cancelable event never throws", () => {
    renderStrip();
    // A non-cancelable KeyboardEvent: preventDefault is a no-op but must not throw.
    const evt = new KeyboardEvent("keydown", {
      key: "Tab",
      ctrlKey: true,
      cancelable: false,
      bubbles: true,
    });
    expect(() => window.dispatchEvent(evt)).not.toThrow();
    expect(useTabStore.getState().activeTabId).toBe("b");
  });
});

describe("<TabStrip /> ghost drag (MTR ghost + dim)", () => {
  it("pointerDown + pointerMove past threshold renders tab-drag-ghost", () => {
    renderStrip();
    const strip = screen.getByRole("tablist");
    const wrapper = screen.getByText("Title b").closest("[data-tab-wrapper]") as HTMLElement;
    expect(wrapper).not.toBeNull();

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 120, pointerId: 1 });

    expect(screen.getByTestId("tab-drag-ghost")).toBeInTheDocument();
  });

  it("pointerUp removes the ghost (count 0 after release)", () => {
    renderStrip();
    const strip = screen.getByRole("tablist");
    const wrapper = screen.getByText("Title b").closest("[data-tab-wrapper]") as HTMLElement;

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 120, pointerId: 1 });
    expect(screen.getByTestId("tab-drag-ghost")).toBeInTheDocument();

    fireEvent.pointerUp(strip, { button: 0, clientX: 120, pointerId: 1 });
    expect(screen.queryByTestId("tab-drag-ghost")).not.toBeInTheDocument();
  });

  it("a second pointerMove updates the ghost position without throwing", () => {
    renderStrip();
    const strip = screen.getByRole("tablist");
    const wrapper = screen.getByText("Title b").closest("[data-tab-wrapper]") as HTMLElement;

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 120, pointerId: 1 });
    expect(() => {
      fireEvent.pointerMove(strip, { clientX: 140, pointerId: 1 });
    }).not.toThrow();
    expect(screen.getByTestId("tab-drag-ghost")).toBeInTheDocument();
  });

  it("pointerCancel removes the ghost (no stranded ghost)", () => {
    renderStrip();
    const strip = screen.getByRole("tablist");
    const wrapper = screen.getByText("Title b").closest("[data-tab-wrapper]") as HTMLElement;

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 120, pointerId: 1 });
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
    fireEvent.pointerMove(strip, { clientX: 103, pointerId: 1 });

    expect(screen.queryByTestId("tab-drag-ghost")).not.toBeInTheDocument();
  });

  it("POLISH-GHOST: ghost renders a real TabPill with a visible Close button", () => {
    // Drag tab `a` (the default active tab in renderStrip).
    renderStrip();
    const strip = screen.getByRole("tablist");
    const wrapper = screen.getByText("Title a").closest("[data-tab-wrapper]") as HTMLElement;
    expect(wrapper).not.toBeNull();

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 120, pointerId: 1 });

    const ghost = screen.getByTestId("tab-drag-ghost");
    expect(ghost).toBeInTheDocument();
    // A real TabPill always renders an aria-labelled Close button — a title-only
    // lightweight ghost would not have this element.
    // { hidden: true } because the ghost container carries aria-hidden="true" (it's a
    // visual decoration); we still want to assert the Close button is physically present.
    expect(within(ghost).getByRole("button", { name: /^Close/, hidden: true })).toBeInTheDocument();
  });

  it("POLISH-OVERLAY: drop indicator is position:absolute and not inside any tab wrapper", () => {
    renderStrip();
    const strip = screen.getByRole("tablist");
    const wrapper = screen.getByText("Title b").closest("[data-tab-wrapper]") as HTMLElement;
    expect(wrapper).not.toBeNull();

    fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 120, pointerId: 1 });

    const indicator = screen.getByTestId("tab-drop-indicator");
    expect(indicator).toBeInTheDocument();
    // jsdom reflects inline styles in getComputedStyle — verifies the overlay approach.
    expect(getComputedStyle(indicator).position).toBe("absolute");
    // The indicator must be a strip-level child, not inside any tab wrapper
    // (it is an overlay, not an inline flex-child that would shift other pills).
    expect(indicator.closest("[data-tab-wrapper]")).toBeNull();
  });
});

describe("<TabStrip /> right-hand cluster (Plan 18-02 — relocated per D-04)", () => {
  beforeEach(() => {
    useTreeStore.setState({
      notesSidebarVisible: true,
      backlinksRailExpanded: true,
    });
  });

  it("shows aria-label 'Hide notes sidebar' when notesSidebarVisible is true", () => {
    useTreeStore.setState({ notesSidebarVisible: true });
    renderStrip();
    expect(
      screen.getByRole("button", { name: "Hide notes sidebar" }),
    ).toBeInTheDocument();
  });

  it("shows aria-label 'Show notes sidebar' when notesSidebarVisible is false", () => {
    useTreeStore.setState({ notesSidebarVisible: false });
    renderStrip();
    expect(
      screen.getByRole("button", { name: "Show notes sidebar" }),
    ).toBeInTheDocument();
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

  it("clicking the left toggle calls setNotesSidebarVisible(!notesSidebarVisible)", () => {
    useTreeStore.setState({ notesSidebarVisible: true });
    renderStrip();
    fireEvent.click(screen.getByRole("button", { name: "Hide notes sidebar" }));
    expect(useTreeStore.getState().notesSidebarVisible).toBe(false);
  });

  it("clicking the right toggle calls setBacklinksRailExpanded(!backlinksRailExpanded)", () => {
    useTreeStore.setState({ backlinksRailExpanded: true });
    renderStrip();
    fireEvent.click(screen.getByRole("button", { name: "Hide panels" }));
    expect(useTreeStore.getState().backlinksRailExpanded).toBe(false);
  });

  it("mounts the PanelSelectorDropdown inside the strip", () => {
    renderStrip();
    expect(screen.getByRole("button", { name: "Open panel" })).toBeInTheDocument();
  });

  // D-04: the old chrome wrapper gated the right-rail toggle behind
  // panelSelectorState.tags || panelSelectorState.backlinks (TBR-N3-3/4a/4b,
  // RR-T-1). That gate is intentionally dropped here — the right toggle is
  // ALWAYS rendered regardless of panelSelector state.
  it("D-04: right-rail toggle is ALWAYS rendered regardless of panelSelector state", () => {
    useTreeStore.setState({ panelSelector: { tags: false, backlinks: false } });
    renderStrip();
    expect(
      screen.queryByRole("button", { name: /hide panels|show panels/i }),
    ).not.toBeNull();
  });

  it("right cluster is present in the zero-tab empty state too", () => {
    render(
      <TabStrip
        tabs={[]}
        activeTabId={null}
        deletedTabIds={new Set()}
        titleForTab={titleForTab}
        onSelectTab={vi.fn()}
        onRequestClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseToRight={vi.fn()}
        onOpenRight={vi.fn()}
        onReorder={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );
    expect(screen.getByTestId("tab-strip-right-cluster")).toBeInTheDocument();
  });
});
