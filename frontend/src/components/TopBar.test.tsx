/**
 * TopBar tests — sidebar toggle, Breadcrumbs, PanelSelectorDropdown,
 * right-rail toggle, style tokens, aria-label state, style prop merge.
 *
 * Child components are mocked to focus tests on TopBar-specific behavior.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";


vi.mock("../lib/adminApi", () => ({
  postAdminReindex: vi.fn().mockResolvedValue({ data: {}, response: { status: 200 } }),
}));

import { postAdminReindex } from "../lib/adminApi";
import { TopBar } from "./TopBar";


vi.mock("./Breadcrumbs", () => ({
  Breadcrumbs: () => <div data-testid="mock-breadcrumbs">Breadcrumbs</div>,
}));

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


let mockTagCount = 0;
let mockBacklinkCount = 0;

vi.mock("../lib/useTagsForNote", () => ({
  useTagsForNote: () => ({
    tags: Array.from({ length: mockTagCount }, (_, i) => `tag${i}`),
    loading: false,
    error: null,
  }),
}));

vi.mock("../lib/useBacklinks", () => ({
  useBacklinks: () => ({
    backlinks: Array.from({ length: mockBacklinkCount }, (_, i) => ({ id: `b${i}`, title: `Note ${i}`, path: `note${i}.md` })),
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));


describe("TopBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockBacklinksRailExpanded = true;
    mockTagCount = 1;
    mockBacklinkCount = 0;
  });

  it("renders a container with the correct background, boxShadow, and height styles", () => {
    render(<TopBar />);
    const container = screen.getByTestId("top-bar");
    expect(container.style.background).toBe("var(--color-bg)");
    expect(container.style.boxShadow).toBe("var(--shadow-elevation-1)");
    expect(container.style.height).toBe("40px");
  });

  it("shows aria-label 'Hide notes sidebar' when notesSidebarVisible is true", () => {
    mockNotesSidebarVisible = true;
    render(<TopBar />);
    expect(
      screen.getByRole("button", { name: "Hide notes sidebar" }),
    ).toBeTruthy();
  });

  it("shows aria-label 'Show notes sidebar' when notesSidebarVisible is false", () => {
    mockNotesSidebarVisible = false;
    render(<TopBar />);
    expect(
      screen.getByRole("button", { name: "Show notes sidebar" }),
    ).toBeTruthy();
  });

  it("calls setNotesSidebarVisible(!notesSidebarVisible) when sidebar toggle clicked", () => {
    mockNotesSidebarVisible = true;
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Hide notes sidebar" }));
    expect(mockSetNotesSidebarVisible).toHaveBeenCalledWith(false);
  });

  it("calls setNotesSidebarVisible(true) when sidebar toggle clicked and sidebar is hidden", () => {
    mockNotesSidebarVisible = false;
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Show notes sidebar" }));
    expect(mockSetNotesSidebarVisible).toHaveBeenCalledWith(true);
  });

  it("renders the Breadcrumbs component", () => {
    render(<TopBar />);
    expect(screen.getByTestId("mock-breadcrumbs")).toBeTruthy();
  });

  it("renders the PanelSelectorDropdown component", () => {
    render(<TopBar />);
    expect(screen.getByTestId("mock-panel-selector-dropdown")).toBeTruthy();
  });

  it("shows aria-label 'Hide panels' when backlinksRailExpanded is true", () => {
    mockBacklinksRailExpanded = true;
    render(<TopBar />);
    expect(screen.getByRole("button", { name: "Hide panels" })).toBeTruthy();
  });

  it("shows aria-label 'Show panels' when backlinksRailExpanded is false", () => {
    mockBacklinksRailExpanded = false;
    render(<TopBar />);
    expect(screen.getByRole("button", { name: "Show panels" })).toBeTruthy();
  });

  it("calls setBacklinksRailExpanded(!backlinksRailExpanded) when right-rail toggle clicked", () => {
    mockBacklinksRailExpanded = true;
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Hide panels" }));
    expect(mockSetBacklinksRailExpanded).toHaveBeenCalledWith(false);
  });

  it("calls setBacklinksRailExpanded(true) when right-rail toggle clicked and rail is hidden", () => {
    mockBacklinksRailExpanded = false;
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Show panels" }));
    expect(mockSetBacklinksRailExpanded).toHaveBeenCalledWith(true);
  });

  it("has zIndex 10 on the container", () => {
    render(<TopBar />);
    const container = screen.getByTestId("top-bar");
    expect(container.style.zIndex).toBe("10");
  });

  it("merges extra style props into the container (e.g. gridRow, gridColumn)", () => {
    render(<TopBar style={{ gridRow: "1", gridColumn: "2" }} />);
    const container = screen.getByTestId("top-bar");
    expect(container.style.gridRow).toBe("1");
    expect(container.style.gridColumn).toBe("2");
    expect(container.style.background).toBe("var(--color-bg)");
  });
});


describe("RR-toggle-hide — right-rail toggle gate (Plan 07-38 supersedes UAT-2 N3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockBacklinksRailExpanded = true;
    mockPanelSelector = { tags: true, backlinks: true };
  });

  it("RR-T-1 (Plan 07-38): zero tags + zero backlinks BUT default panelSelector=both-selected → toggle RENDERED", () => {
    mockTagCount = 0;
    mockBacklinkCount = 0;
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: /hide panels|show panels/i })).not.toBeNull();
  });

  it("RR-T-2: 1 tag → toggle still rendered (unchanged)", () => {
    mockTagCount = 1;
    mockBacklinkCount = 0;
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: /hide panels|show panels/i })).not.toBeNull();
  });

  it("RR-T-3: 1 backlink → toggle still rendered (unchanged)", () => {
    mockTagCount = 0;
    mockBacklinkCount = 1;
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: /hide panels|show panels/i })).not.toBeNull();
  });
});


describe("TBR-FIX (superseded by Plan 07-38) — content no longer gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockBacklinksRailExpanded = true;
    mockPanelSelector = { tags: true, backlinks: true };
  });

  it("TBR-FIX-2 (kept): toggle visible when panelSelector indicates any panel selected", () => {
    mockTagCount = 1;
    mockBacklinkCount = 0;
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: /hide panels|show panels/i })).not.toBeNull();
  });
});


describe("TBR-N9 — SaveIndicator removed from TopBar (Plan 07-38)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockBacklinksRailExpanded = true;
    mockTagCount = 0;
    mockBacklinkCount = 0;
    mockSaveState = { status: "idle" };
  });

  it("TBR-N9-1: TopBar does NOT render a SaveIndicator-button (no [data-save-state])", () => {
    mockPanelSelector = { tags: true, backlinks: true };
    const { container } = render(<TopBar />);
    expect(container.querySelector("[data-save-state]")).toBeNull();
  });

  it("TBR-N9-2: TopBar does NOT call postAdminReindex on mount", () => {
    render(<TopBar />);
    expect(postAdminReindex).not.toHaveBeenCalled();
  });

  it("TBR-N9-3: TopBar still renders PanelSelectorDropdown (Task 2) and breadcrumbs", () => {
    render(<TopBar />);
    expect(screen.getByTestId("mock-panel-selector-dropdown")).toBeTruthy();
    expect(screen.getByTestId("mock-breadcrumbs")).toBeTruthy();
  });
});


describe("TBR-N3 — PanelSelectorDropdown always visible + selection-gated rail toggle (Plan 07-38)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockBacklinksRailExpanded = true;
    mockTagCount = 0;
    mockBacklinkCount = 0;
    mockActiveNoteId = "note-1";
    mockPanelSelector = { tags: true, backlinks: true };
    mockSaveState = { status: "idle" };
  });

  it("TBR-N3-1: PanelSelectorDropdown is rendered when activeNote has 0 tags + 0 backlinks", () => {
    mockTagCount = 0;
    mockBacklinkCount = 0;
    render(<TopBar />);
    expect(screen.queryByTestId("mock-panel-selector-dropdown")).not.toBeNull();
  });

  it("TBR-N3-2: PanelSelectorDropdown is rendered when there is no active note (attachment preview)", () => {
    mockActiveNoteId = null;
    mockTagCount = 0;
    mockBacklinkCount = 0;
    render(<TopBar />);
    expect(screen.queryByTestId("mock-panel-selector-dropdown")).not.toBeNull();
  });

  it("TBR-N3-3: right-rail toggle HIDDEN when panelSelector.tags=false AND panelSelector.backlinks=false", () => {
    mockPanelSelector = { tags: false, backlinks: false };
    mockTagCount = 5;
    mockBacklinkCount = 3;
    render(<TopBar />);
    expect(
      screen.queryByRole("button", { name: /hide panels|show panels/i }),
    ).toBeNull();
  });

  it("TBR-N3-4a: right-rail toggle VISIBLE when panelSelector.tags=true", () => {
    mockPanelSelector = { tags: true, backlinks: false };
    mockTagCount = 0;
    mockBacklinkCount = 0;
    render(<TopBar />);
    expect(
      screen.queryByRole("button", { name: /hide panels|show panels/i }),
    ).not.toBeNull();
  });

  it("TBR-N3-4b: right-rail toggle VISIBLE when panelSelector.backlinks=true", () => {
    mockPanelSelector = { tags: false, backlinks: true };
    mockTagCount = 0;
    mockBacklinkCount = 0;
    render(<TopBar />);
    expect(
      screen.queryByRole("button", { name: /hide panels|show panels/i }),
    ).not.toBeNull();
  });
});
