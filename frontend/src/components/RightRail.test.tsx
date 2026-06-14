/**
 * RightRail tests.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";


const mockSetExpanded = vi.fn();
const mockSetWidth = vi.fn();

let mockExpanded = false;
let mockWidth = 280;
let mockHeightRatio = 0.5;
let mockPanelSelector = { tags: true, backlinks: true };

vi.mock("../lib/useTreeStore", () => ({
  useTreeStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      backlinksRailExpanded: mockExpanded,
      backlinksRailWidth: mockWidth,
      setBacklinksRailExpanded: mockSetExpanded,
      setBacklinksRailWidth: mockSetWidth,
      tagsPanelHeightRatio: mockHeightRatio,
      panelSelector: mockPanelSelector,
    };
    return selector(state);
  },
  RAIL_MAX_WIDTH: 480,
  RAIL_MIN_WIDTH: 220,
  RAIL_COLLAPSED_WIDTH: 32,
}));


vi.mock("./RightRailTagsPanel", () => ({
  RightRailTagsPanel: () => <div data-testid="mock-tags-panel">Tags Panel</div>,
}));
vi.mock("./BacklinksRail", () => ({
  BacklinksRail: ({ noteId }: { noteId: string | null }) => (
    <div data-testid="mock-backlinks-rail" data-noteid={noteId ?? "null"}>
      Backlinks Rail
    </div>
  ),
}));
vi.mock("./InterPanelDivider", () => ({
  InterPanelDivider: () => (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize panels"
      data-testid="inter-panel-divider"
    />
  ),
}));


import { RightRail } from "./RightRail";

describe("RightRail — Phase 6.6: collapsed returns null (D-36)", () => {
  beforeEach(() => {
    mockExpanded = false;
    mockWidth = 280;
    mockPanelSelector = { tags: true, backlinks: true };
    mockSetExpanded.mockReset();
    mockSetWidth.mockReset();
  });

  it("RR-1: when backlinksRailExpanded=false, RightRail renders null (no aside)", () => {
    const { container } = render(<RightRail activeNoteId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("RR-6: no 'Show panels' button inside RightRail anymore (rail-level toggle gone, D-36)", () => {
    render(<RightRail activeNoteId={null} />);
    expect(screen.queryByRole("button", { name: /show panels/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /show backlinks panel/i })).toBeNull();
  });
});

describe("RightRail — Phase 6.6: expanded state + panelSelector gating", () => {
  beforeEach(() => {
    mockExpanded = true;
    mockWidth = 280;
    mockHeightRatio = 0.5;
    mockPanelSelector = { tags: true, backlinks: true };
    mockSetExpanded.mockReset();
    mockSetWidth.mockReset();
  });

  it("RR-2: both panelSelector true — both panels + InterPanelDivider render", () => {
    mockPanelSelector = { tags: true, backlinks: true };
    render(<RightRail activeNoteId={null} />);
    expect(screen.getByTestId("mock-tags-panel")).toBeInTheDocument();
    expect(screen.getByTestId("mock-backlinks-rail")).toBeInTheDocument();
    expect(screen.getByTestId("inter-panel-divider")).toBeInTheDocument();
  });

  it("RR-3: panelSelector.tags=false → RightRailTagsPanel NOT rendered", () => {
    mockPanelSelector = { tags: false, backlinks: true };
    render(<RightRail activeNoteId={null} />);
    expect(screen.queryByTestId("mock-tags-panel")).toBeNull();
    expect(screen.getByTestId("mock-backlinks-rail")).toBeInTheDocument();
  });

  it("RR-4: panelSelector.backlinks=false → BacklinksRail NOT rendered", () => {
    mockPanelSelector = { tags: true, backlinks: false };
    render(<RightRail activeNoteId={null} />);
    expect(screen.queryByTestId("mock-backlinks-rail")).toBeNull();
    expect(screen.getByTestId("mock-tags-panel")).toBeInTheDocument();
  });

  it("RR-4b: InterPanelDivider NOT rendered when only one panel is visible", () => {
    mockPanelSelector = { tags: true, backlinks: false };
    render(<RightRail activeNoteId={null} />);
    expect(screen.queryByTestId("inter-panel-divider")).toBeNull();
  });

  it("RR-5: both panelSelector false + expanded=true → auto-collapse fires (setBacklinksRailExpanded(false))", () => {
    mockPanelSelector = { tags: false, backlinks: false };
    mockExpanded = true;
    act(() => {
      render(<RightRail activeNoteId={null} />);
    });
    expect(mockSetExpanded).toHaveBeenCalledWith(false);
  });

  it("RR-2b: expanded rail still has vertical resize handle", () => {
    render(<RightRail activeNoteId={null} />);
    const separators = screen.getAllByRole("separator");
    const verticalHandle = separators.find(
      (s) => s.getAttribute("aria-orientation") === "vertical",
    );
    expect(verticalHandle).toBeDefined();
    expect(verticalHandle).toHaveAttribute("aria-label", "Resize backlinks panel");
  });

  it("RR: expanded rail background is --color-bg (floating panel aesthetic)", () => {
    const { container } = render(<RightRail activeNoteId={null} />);
    const aside = container.querySelector("aside");
    expect(aside).toBeTruthy();
    const styleAttr = aside?.getAttribute("style") ?? "";
    expect(styleAttr).toContain("var(--color-bg)");
  });

  it("RR: BacklinksRail receives activeNoteId prop", () => {
    render(<RightRail activeNoteId="abc-123" />);
    const backlinksRail = screen.getByTestId("mock-backlinks-rail");
    expect(backlinksRail).toHaveAttribute("data-noteid", "abc-123");
  });

  it("RR: pointerdown on vertical resize handle + pointermove updates width via store setter", () => {
    render(<RightRail activeNoteId={null} />);
    const separators = screen.getAllByRole("separator");
    const handle = separators.find(
      (s) => s.getAttribute("aria-orientation") === "vertical",
    );
    expect(handle).toBeDefined();

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1440,
    });

    fireEvent.pointerDown(handle!, { clientX: 0 });
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 1200, bubbles: true }));
    expect(mockSetWidth).toHaveBeenCalledWith(240);
    document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  });

  it("RR: style prop is merged onto the expanded aside for grid placement", () => {
    const { container } = render(
      <RightRail activeNoteId={null} style={{ gridRow: "1 / 3", gridColumn: "3" }} />,
    );
    const aside = container.querySelector("aside");
    expect(aside).toBeTruthy();
    expect(aside!.style.gridRow).toBe("1 / 3");
    expect(aside!.style.gridColumn).toBe("3");
  });
});
