/**
 * ChromeBar tests — sidebar toggle, child (TabStrip) slot, PanelSelectorDropdown,
 * right-rail toggle, style tokens, aria-label state, style prop merge.
 *
 * Child components are mocked to focus tests on ChromeBar-specific behavior.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/adminApi", () => ({
  postAdminReindex: vi.fn().mockResolvedValue({ data: {}, response: { status: 200 } }),
}));

import { postAdminReindex } from "../lib/adminApi";
import { ChromeBar } from "./ChromeBar";

vi.mock("./PanelSelectorDropdown", () => ({
  PanelSelectorDropdown: () => (
    <div data-testid="mock-panel-selector-dropdown">PanelSelectorDropdown</div>
  ),
}));

const mockSetNotesSidebarVisible = vi.fn();
const mockSetBacklinksRailExpanded = vi.fn();

let mockNotesSidebarVisible = true;
let mockBacklinksRailExpanded = true;

let mockSaveState: import("../lib/saveStateMachine").SaveState = { status: "idle" };

let mockPanelSelector: { tags: boolean; backlinks: boolean } = {
  tags: true,
  backlinks: true,
};

let mockActiveNoteId: string | null = "note-1";

vi.mock("../lib/useTreeStore", () => ({
  useTreeStore: (selector: (s: unknown) => unknown) => {
    const state = {
      notesSidebarVisible: mockNotesSidebarVisible,
      setNotesSidebarVisible: mockSetNotesSidebarVisible,
      backlinksRailExpanded: mockBacklinksRailExpanded,
      setBacklinksRailExpanded: mockSetBacklinksRailExpanded,
      activeNoteId: mockActiveNoteId,
      saveState: mockSaveState,
      panelSelector: mockPanelSelector,
    };
    return selector(state);
  },
}));

/** Child probe standing in for the TabStrip slot. */
const Child = () => <div data-testid="strip-slot">strip</div>;

describe("ChromeBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockBacklinksRailExpanded = true;
    mockPanelSelector = { tags: true, backlinks: true };
  });

  it("renders a single 36px row with the bg + bottom border tokens", () => {
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    const container = screen.getByTestId("chrome-bar");
    expect(container.style.background).toBe("var(--color-bg)");
    expect(container.style.borderBottom).toBe("1px solid var(--color-border)");
    expect(container.style.height).toBe("36px");
    expect(container.style.alignItems).toBe("flex-end");
  });

  it("renders the child (TabStrip) slot between the toggles", () => {
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    expect(screen.getByTestId("strip-slot")).toBeTruthy();
  });

  it("shows aria-label 'Hide notes sidebar' when notesSidebarVisible is true", () => {
    mockNotesSidebarVisible = true;
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    expect(
      screen.getByRole("button", { name: "Hide notes sidebar" }),
    ).toBeTruthy();
  });

  it("shows aria-label 'Show notes sidebar' when notesSidebarVisible is false", () => {
    mockNotesSidebarVisible = false;
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    expect(
      screen.getByRole("button", { name: "Show notes sidebar" }),
    ).toBeTruthy();
  });

  it("calls setNotesSidebarVisible(!notesSidebarVisible) when sidebar toggle clicked", () => {
    mockNotesSidebarVisible = true;
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide notes sidebar" }));
    expect(mockSetNotesSidebarVisible).toHaveBeenCalledWith(false);
  });

  it("calls setNotesSidebarVisible(true) when sidebar toggle clicked and sidebar is hidden", () => {
    mockNotesSidebarVisible = false;
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show notes sidebar" }));
    expect(mockSetNotesSidebarVisible).toHaveBeenCalledWith(true);
  });

  it("renders the PanelSelectorDropdown component", () => {
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    expect(screen.getByTestId("mock-panel-selector-dropdown")).toBeTruthy();
  });

  it("shows aria-label 'Hide panels' when backlinksRailExpanded is true", () => {
    mockBacklinksRailExpanded = true;
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    expect(screen.getByRole("button", { name: "Hide panels" })).toBeTruthy();
  });

  it("shows aria-label 'Show panels' when backlinksRailExpanded is false", () => {
    mockBacklinksRailExpanded = false;
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    expect(screen.getByRole("button", { name: "Show panels" })).toBeTruthy();
  });

  it("calls setBacklinksRailExpanded(!backlinksRailExpanded) when right-rail toggle clicked", () => {
    mockBacklinksRailExpanded = true;
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide panels" }));
    expect(mockSetBacklinksRailExpanded).toHaveBeenCalledWith(false);
  });

  it("calls setBacklinksRailExpanded(true) when right-rail toggle clicked and rail is hidden", () => {
    mockBacklinksRailExpanded = false;
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show panels" }));
    expect(mockSetBacklinksRailExpanded).toHaveBeenCalledWith(true);
  });

  it("has zIndex 10 on the container", () => {
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    const container = screen.getByTestId("chrome-bar");
    expect(container.style.zIndex).toBe("10");
  });

  it("merges extra style props into the container (e.g. gridRow, gridColumn)", () => {
    render(
      <ChromeBar style={{ gridRow: "1", gridColumn: "2" }}>
        <Child />
      </ChromeBar>,
    );
    const container = screen.getByTestId("chrome-bar");
    expect(container.style.gridRow).toBe("1");
    expect(container.style.gridColumn).toBe("2");
    expect(container.style.background).toBe("var(--color-bg)");
  });
});

describe("RR-toggle — right-rail toggle gate (Plan 07-38 supersedes UAT-2 N3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockBacklinksRailExpanded = true;
    mockPanelSelector = { tags: true, backlinks: true };
  });

  it("RR-T-1: default panelSelector=both-selected → toggle RENDERED", () => {
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    expect(
      screen.queryByRole("button", { name: /hide panels|show panels/i }),
    ).not.toBeNull();
  });
});

describe("TBR-N9 — chrome carries no SaveIndicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockBacklinksRailExpanded = true;
    mockSaveState = { status: "idle" };
  });

  it("TBR-N9-1: ChromeBar does NOT render a SaveIndicator-button (no [data-save-state])", () => {
    mockPanelSelector = { tags: true, backlinks: true };
    const { container } = render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    expect(container.querySelector("[data-save-state]")).toBeNull();
  });

  it("TBR-N9-2: ChromeBar does NOT call postAdminReindex on mount", () => {
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    expect(postAdminReindex).not.toHaveBeenCalled();
  });

  it("TBR-N9-3: ChromeBar renders PanelSelectorDropdown only (no breadcrumb)", () => {
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    expect(screen.getByTestId("mock-panel-selector-dropdown")).toBeTruthy();
    expect(screen.queryByLabelText("Note path")).toBeNull();
  });
});

describe("TBR-N3 — PanelSelectorDropdown always visible + selection-gated rail toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockBacklinksRailExpanded = true;
    mockActiveNoteId = "note-1";
    mockPanelSelector = { tags: true, backlinks: true };
    mockSaveState = { status: "idle" };
  });

  it("TBR-N3-1: PanelSelectorDropdown is rendered (default both-selected)", () => {
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    expect(screen.queryByTestId("mock-panel-selector-dropdown")).not.toBeNull();
  });

  it("TBR-N3-2: PanelSelectorDropdown is rendered when there is no active note", () => {
    mockActiveNoteId = null;
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    expect(screen.queryByTestId("mock-panel-selector-dropdown")).not.toBeNull();
  });

  it("TBR-N3-3: right-rail toggle HIDDEN when tags=false AND backlinks=false", () => {
    mockPanelSelector = { tags: false, backlinks: false };
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    expect(
      screen.queryByRole("button", { name: /hide panels|show panels/i }),
    ).toBeNull();
  });

  it("TBR-N3-4a: right-rail toggle VISIBLE when tags=true", () => {
    mockPanelSelector = { tags: true, backlinks: false };
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    expect(
      screen.queryByRole("button", { name: /hide panels|show panels/i }),
    ).not.toBeNull();
  });

  it("TBR-N3-4b: right-rail toggle VISIBLE when backlinks=true", () => {
    mockPanelSelector = { tags: false, backlinks: true };
    render(
      <ChromeBar>
        <Child />
      </ChromeBar>,
    );
    expect(
      screen.queryByRole("button", { name: /hide panels|show panels/i }),
    ).not.toBeNull();
  });
});
