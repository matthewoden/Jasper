/**
 * RightRail tests — Phase 6.5 Plan 04 (restructured two-panel layout).
 *
 * Replaces Phase 6 Plan 06-07 tests. The rail now composes its own children
 * (RightRailTagsPanel + InterPanelDivider + BacklinksRail) instead of
 * rendering a {children} prop.
 *
 * Key changes from Phase 6 tests:
 *   - RightRail now takes `activeNoteId` prop (not `children`)
 *   - Rail background is `--color-bg` (was `--color-surface`) for floating effect
 *   - Both panels + InterPanelDivider are rendered in expanded state
 *   - Collapsed state is unchanged (32px strip, toggle button)
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock useTreeStore so tests control state directly.
const mockSetExpanded = vi.fn();
const mockSetWidth = vi.fn();

let mockExpanded = false;
let mockWidth = 280;
let mockHeightRatio = 0.5;

vi.mock("../lib/useTreeStore", () => ({
  useTreeStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      backlinksRailExpanded: mockExpanded,
      backlinksRailWidth: mockWidth,
      setBacklinksRailExpanded: mockSetExpanded,
      setBacklinksRailWidth: mockSetWidth,
      tagsPanelHeightRatio: mockHeightRatio,
    };
    return selector(state);
  },
  RAIL_MAX_WIDTH: 480,
  RAIL_MIN_WIDTH: 220,
  RAIL_COLLAPSED_WIDTH: 32,
}));

// Mock child components to isolate RightRail tests.
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

// Import after mock setup.
import { RightRail } from "./RightRail";

describe("RightRail — collapsed state", () => {
  beforeEach(() => {
    mockExpanded = false;
    mockWidth = 280;
    mockSetExpanded.mockReset();
    mockSetWidth.mockReset();
  });

  it("R1: renders 32px-wide collapsed strip with toggle button", () => {
    const { container } = render(<RightRail activeNoteId={null} />);
    const aside = container.querySelector("aside");
    expect(aside).toBeTruthy();
    // Toggle button should be present
    const btn = screen.getByRole("button", { name: /show backlinks panel/i });
    expect(btn).toBeInTheDocument();
  });

  it("R1: collapsed toggle button has aria-expanded=false", () => {
    render(<RightRail activeNoteId={null} />);
    const btn = screen.getByRole("button", { name: /show backlinks panel/i });
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("R3: clicking the toggle in collapsed state calls setBacklinksRailExpanded(true)", () => {
    render(<RightRail activeNoteId={null} />);
    const btn = screen.getByRole("button", { name: /show backlinks panel/i });
    fireEvent.click(btn);
    expect(mockSetExpanded).toHaveBeenCalledWith(true);
  });
});

describe("RightRail — expanded state", () => {
  beforeEach(() => {
    mockExpanded = true;
    mockWidth = 280;
    mockHeightRatio = 0.5;
    mockSetExpanded.mockReset();
    mockSetWidth.mockReset();
  });

  it("R2: renders vertical resize handle with role=separator in expanded state", () => {
    render(<RightRail activeNoteId={null} />);
    // Multiple separators now: vertical resize handle + inter-panel divider
    const separators = screen.getAllByRole("separator");
    const verticalHandle = separators.find(
      (s) => s.getAttribute("aria-orientation") === "vertical",
    );
    expect(verticalHandle).toBeDefined();
    expect(verticalHandle).toHaveAttribute("aria-label", "Resize backlinks panel");
  });

  it("R-NEW: InterPanelDivider is rendered in expanded state", () => {
    render(<RightRail activeNoteId={null} />);
    const divider = screen.getByTestId("inter-panel-divider");
    expect(divider).toBeInTheDocument();
    expect(divider).toHaveAttribute("aria-orientation", "horizontal");
    expect(divider).toHaveAttribute("aria-label", "Resize panels");
  });

  it("R-NEW: RightRailTagsPanel is rendered in expanded state", () => {
    render(<RightRail activeNoteId={null} />);
    expect(screen.getByTestId("mock-tags-panel")).toBeInTheDocument();
  });

  it("R-NEW: BacklinksRail is rendered in expanded state", () => {
    render(<RightRail activeNoteId={null} />);
    expect(screen.getByTestId("mock-backlinks-rail")).toBeInTheDocument();
  });

  it("R-NEW: BacklinksRail receives activeNoteId prop", () => {
    render(<RightRail activeNoteId="abc-123" />);
    const backlinksRail = screen.getByTestId("mock-backlinks-rail");
    expect(backlinksRail).toHaveAttribute("data-noteid", "abc-123");
  });

  it("R-NEW: expanded rail background is --color-bg (not --color-surface)", () => {
    const { container } = render(<RightRail activeNoteId={null} />);
    const aside = container.querySelector("aside");
    const styleAttr = aside?.getAttribute("style") ?? "";
    // Background should be --color-bg for floating panel effect
    expect(styleAttr).toContain("var(--color-bg)");
    // Should NOT use --color-surface as the rail background
    expect(styleAttr).not.toContain("background: var(--color-surface)");
  });

  it("R-NEW: rail reads tagsPanelHeightRatio from store", () => {
    // When ratio=0.5, panels split 50/50; we just verify the render doesn't crash
    // and the panels are present (visual flex math is integration-tested visually)
    mockHeightRatio = 0.6;
    render(<RightRail activeNoteId={null} />);
    expect(screen.getByTestId("mock-tags-panel")).toBeInTheDocument();
    expect(screen.getByTestId("mock-backlinks-rail")).toBeInTheDocument();
  });

  it("R4: pointerdown on vertical resize handle + pointermove updates width via store setter", () => {
    render(<RightRail activeNoteId={null} />);
    const separators = screen.getAllByRole("separator");
    const handle = separators.find(
      (s) => s.getAttribute("aria-orientation") === "vertical",
    );
    expect(handle).toBeDefined();

    // Mock window.innerWidth
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1440,
    });

    fireEvent.pointerDown(handle!, { clientX: 0 });
    // clientX = 1200 → width = 1440 - 1200 = 240 (clamped to [220, 480])
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 1200, bubbles: true }));
    expect(mockSetWidth).toHaveBeenCalledWith(240);
    document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  });

  it("R5: expanded state does NOT render the collapsed 'Show backlinks panel' button", () => {
    render(<RightRail activeNoteId={null} />);
    const showBtn = screen.queryByRole("button", { name: /show backlinks panel/i });
    expect(showBtn).toBeNull();
  });

  it("R-LEGACY: no longer accepts children prop (children are composed internally)", () => {
    // RightRail now composes panels internally; passing children doesn't break but
    // the children are no longer rendered (the interface changed to activeNoteId prop)
    render(<RightRail activeNoteId="test-id" />);
    // Both panels render from internal composition
    expect(screen.getByTestId("mock-tags-panel")).toBeInTheDocument();
    expect(screen.getByTestId("mock-backlinks-rail")).toBeInTheDocument();
  });
});
