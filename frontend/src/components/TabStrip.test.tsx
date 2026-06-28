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
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabStrip } from "./TabStrip";
import { useTabStore } from "../lib/useTabStore";
import type { Tab } from "../lib/useTabStore";

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

  it("BUG 3c: empty-state new-tab button is tab-shaped (top-rounded pill, not a bare icon)", () => {
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
    // Loose silhouette check: top-rounded corners like a TabPill (not a 4px square icon button).
    expect(btn.style.borderRadius).toBe("4px 4px 0 0");
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
    fireEvent.keyDown(window, { key: "]", altKey: true });
    expect(useTabStore.getState().activeTabId).toBe("b");
  });

  it("TAB-11: Alt+[ moves to the previous tab (cycleTab(-1))", () => {
    useTabStore.setState({ activeTabId: "b" });
    renderStrip({ activeTabId: "b" });
    fireEvent.keyDown(window, { key: "[", altKey: true });
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
    fireEvent.keyDown(window, { key: "w", altKey: true });
    expect(h.onRequestClose).toHaveBeenCalledWith("b");
  });

  it("TAB-05: plain Ctrl+W does NOT trigger close (browser owns it)", () => {
    const h = renderStrip();
    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    expect(h.onRequestClose).not.toHaveBeenCalled();
  });

  it("no-op when there are zero tabs", () => {
    useTabStore.setState({ tabs: [], activeTabId: null });
    const h = renderStrip();
    fireEvent.keyDown(window, { key: "]", altKey: true });
    fireEvent.keyDown(window, { key: "w", altKey: true });
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
