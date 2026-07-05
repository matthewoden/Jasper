/**
 * RightRail tests — Phase 20 three-section shell (Outline → Linked
 * mentions → Tags), each behind an independent SectionHeader collapse
 * boolean; no legacy panel-selector gating remains.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";


const mockSetWidth = vi.fn();
const mockSetOutlinePanelExpanded = vi.fn();
const mockSetLinkedMentionsPanelExpanded = vi.fn();
const mockSetTagsPanelExpanded = vi.fn();
const mockSetOutlineHeightRatio = vi.fn();
const mockSetLinkedMentionsHeightRatio = vi.fn();

let mockExpanded = true;
let mockWidth = 280;
let mockOutlinePanelExpanded = true;
let mockLinkedMentionsPanelExpanded = true;
let mockTagsPanelExpanded = true;
let mockOutlineHeightRatio = 0.34;
let mockLinkedMentionsHeightRatio = 0.34;

const mockStoreState = () => ({
  backlinksRailExpanded: mockExpanded,
  backlinksRailWidth: mockWidth,
  setBacklinksRailWidth: mockSetWidth,
  outlinePanelExpanded: mockOutlinePanelExpanded,
  setOutlinePanelExpanded: mockSetOutlinePanelExpanded,
  linkedMentionsPanelExpanded: mockLinkedMentionsPanelExpanded,
  setLinkedMentionsPanelExpanded: mockSetLinkedMentionsPanelExpanded,
  tagsPanelExpanded: mockTagsPanelExpanded,
  setTagsPanelExpanded: mockSetTagsPanelExpanded,
  outlineHeightRatio: mockOutlineHeightRatio,
  setOutlineHeightRatio: mockSetOutlineHeightRatio,
  linkedMentionsHeightRatio: mockLinkedMentionsHeightRatio,
  setLinkedMentionsHeightRatio: mockSetLinkedMentionsHeightRatio,
});

vi.mock("../lib/useTreeStore", () => ({
  useTreeStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(mockStoreState()),
    { getState: () => mockStoreState() },
  ),
  RAIL_MAX_WIDTH: 480,
  RAIL_MIN_WIDTH: 220,
  RAIL_COLLAPSED_WIDTH: 32,
}));

const mockUseBacklinks = vi.fn();
vi.mock("../lib/useBacklinks", () => ({
  useBacklinks: (...args: unknown[]) => mockUseBacklinks(...args),
}));

const mockUseTagBrowser = vi.fn();
vi.mock("../lib/useTagBrowser", () => ({
  useTagBrowser: () => mockUseTagBrowser(),
}));

vi.mock("./OutlinePanel", () => ({
  OutlinePanel: () => <div data-testid="mock-outline-panel">No headings</div>,
}));
vi.mock("./LinkedMentionsPanel", () => ({
  LinkedMentionsPanel: ({ noteId }: { noteId: string | null }) => (
    <div data-testid="mock-linked-mentions-panel" data-noteid={noteId ?? "null"}>
      No backlinks found
    </div>
  ),
}));
vi.mock("./RightRailTagsPanel", () => ({
  RightRailTagsPanel: () => <div data-testid="mock-tags-panel">Tags Panel</div>,
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

beforeEach(() => {
  mockUseBacklinks.mockReturnValue({
    backlinks: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  mockUseTagBrowser.mockReturnValue({
    tags: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
});

describe("RightRail — collapsed rail returns null", () => {
  beforeEach(() => {
    mockExpanded = false;
    mockWidth = 280;
    mockSetWidth.mockReset();
  });

  it("when backlinksRailExpanded=false, RightRail renders null (no aside)", () => {
    const { container } = render(<RightRail activeNoteId={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("RightRail — three-section shell", () => {
  beforeEach(() => {
    mockExpanded = true;
    mockWidth = 280;
    mockOutlinePanelExpanded = true;
    mockLinkedMentionsPanelExpanded = true;
    mockTagsPanelExpanded = true;
    mockOutlineHeightRatio = 0.34;
    mockLinkedMentionsHeightRatio = 0.34;
    mockSetWidth.mockReset();
    mockSetOutlinePanelExpanded.mockReset();
    mockSetLinkedMentionsPanelExpanded.mockReset();
    mockSetTagsPanelExpanded.mockReset();
    mockUseBacklinks.mockReset();
    mockUseBacklinks.mockReturnValue({
      backlinks: [{ sourceId: "a" }, { sourceId: "b" }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockUseTagBrowser.mockReset();
    mockUseTagBrowser.mockReturnValue({
      tags: [{ name: "alpha", count: 1 }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  it("renders all three sections in order Outline → Linked mentions → Tags", () => {
    render(<RightRail activeNoteId="note-1" />);
    const labels = screen.getAllByText(/^(Outline|Linked mentions|Tags)$/);
    expect(labels.map((el) => el.textContent)).toEqual([
      "Outline",
      "Linked mentions",
      "Tags",
    ]);
  });

  it("renders OutlinePanel, LinkedMentionsPanel, and RightRailTagsPanel bodies when all expanded", () => {
    render(<RightRail activeNoteId="note-1" />);
    expect(screen.getByTestId("mock-outline-panel")).toBeInTheDocument();
    expect(screen.getByTestId("mock-linked-mentions-panel")).toBeInTheDocument();
    expect(screen.getByTestId("mock-tags-panel")).toBeInTheDocument();
  });

  it("LinkedMentionsPanel receives activeNoteId prop", () => {
    render(<RightRail activeNoteId="abc-123" />);
    expect(screen.getByTestId("mock-linked-mentions-panel")).toHaveAttribute(
      "data-noteid",
      "abc-123",
    );
  });

  it("Linked-mentions header shows the distinct-source count (backlinks.length)", () => {
    render(<RightRail activeNoteId="note-1" />);
    const header = screen.getByRole("button", {
      name: /collapse linked mentions panel/i,
    });
    expect(header).toHaveTextContent("2");
  });

  it("Tags header shows tags.length count", () => {
    render(<RightRail activeNoteId="note-1" />);
    const header = screen.getByRole("button", { name: /collapse tags panel/i });
    expect(header).toHaveTextContent("1");
  });

  it("Outline header has no count badge", () => {
    render(<RightRail activeNoteId="note-1" />);
    const header = screen.getByRole("button", { name: /collapse outline panel/i });
    // Header text is exactly "Outline" plus chevron — no numeric badge appended.
    expect(header.textContent).toBe("Outline");
  });

  it("renders two InterPanelDividers when all three sections are expanded", () => {
    render(<RightRail activeNoteId="note-1" />);
    expect(screen.getAllByTestId("inter-panel-divider")).toHaveLength(2);
  });

  it("clicking a SectionHeader calls its setter with the toggled value", () => {
    render(<RightRail activeNoteId="note-1" />);
    fireEvent.click(screen.getByRole("button", { name: /collapse outline panel/i }));
    expect(mockSetOutlinePanelExpanded).toHaveBeenCalledWith(false);
  });

  it("no legacy panel-selector references remain — RightRail renders without that prop/state", () => {
    // Compile-time: RightRail no longer imports the legacy panel-selector slice;
    // runtime smoke check that rendering succeeds without any such mock state.
    expect(() => render(<RightRail activeNoteId={null} />)).not.toThrow();
  });

  it("expanded rail still has vertical resize handle", () => {
    render(<RightRail activeNoteId={null} />);
    const separators = screen.getAllByRole("separator");
    const verticalHandle = separators.find(
      (s) => s.getAttribute("aria-orientation") === "vertical",
    );
    expect(verticalHandle).toBeDefined();
    expect(verticalHandle).toHaveAttribute("aria-label", "Resize backlinks panel");
  });

  it("expanded rail background is --color-bg (floating panel aesthetic)", () => {
    const { container } = render(<RightRail activeNoteId={null} />);
    const aside = container.querySelector("aside");
    expect(aside).toBeTruthy();
    const styleAttr = aside?.getAttribute("style") ?? "";
    expect(styleAttr).toContain("var(--color-bg)");
  });

  it("pointerdown on vertical resize handle + pointermove updates width via store setter", () => {
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

  it("style prop is merged onto the expanded aside for grid placement", () => {
    const { container } = render(
      <RightRail activeNoteId={null} style={{ gridRow: "1 / 3", gridColumn: "3" }} />,
    );
    const aside = container.querySelector("aside");
    expect(aside).toBeTruthy();
    expect(aside!.style.gridRow).toBe("1 / 3");
    expect(aside!.style.gridColumn).toBe("3");
  });
});

describe("RightRail — collapse hides body + removes adjacent divider", () => {
  beforeEach(() => {
    mockExpanded = true;
    mockWidth = 280;
    mockOutlineHeightRatio = 0.34;
    mockLinkedMentionsHeightRatio = 0.34;
    mockSetWidth.mockReset();
    mockSetOutlinePanelExpanded.mockReset();
    mockSetLinkedMentionsPanelExpanded.mockReset();
    mockSetTagsPanelExpanded.mockReset();
    mockUseBacklinks.mockReset();
    mockUseBacklinks.mockReturnValue({
      backlinks: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockUseTagBrowser.mockReset();
    mockUseTagBrowser.mockReturnValue({
      tags: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  it("collapsing Outline hides its body and removes the Outline↔Linked-mentions divider", () => {
    mockOutlinePanelExpanded = false;
    mockLinkedMentionsPanelExpanded = true;
    mockTagsPanelExpanded = true;

    render(<RightRail activeNoteId={null} />);
    expect(screen.queryByTestId("mock-outline-panel")).toBeNull();
    expect(screen.getByTestId("mock-linked-mentions-panel")).toBeInTheDocument();
    expect(screen.getByTestId("mock-tags-panel")).toBeInTheDocument();
    // Only the Linked-mentions↔Tags divider remains.
    expect(screen.getAllByTestId("inter-panel-divider")).toHaveLength(1);
  });

  it("collapsing Linked mentions removes both adjacent dividers", () => {
    mockOutlinePanelExpanded = true;
    mockLinkedMentionsPanelExpanded = false;
    mockTagsPanelExpanded = true;

    render(<RightRail activeNoteId={null} />);
    expect(screen.getByTestId("mock-outline-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-linked-mentions-panel")).toBeNull();
    expect(screen.getByTestId("mock-tags-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("inter-panel-divider")).toBeNull();
  });

  it("collapsing all three sections renders zero bodies and zero dividers", () => {
    mockOutlinePanelExpanded = false;
    mockLinkedMentionsPanelExpanded = false;
    mockTagsPanelExpanded = false;

    render(<RightRail activeNoteId={null} />);
    expect(screen.queryByTestId("mock-outline-panel")).toBeNull();
    expect(screen.queryByTestId("mock-linked-mentions-panel")).toBeNull();
    expect(screen.queryByTestId("mock-tags-panel")).toBeNull();
    expect(screen.queryByTestId("inter-panel-divider")).toBeNull();
    // Headers still render (32px rows) even when every section is collapsed.
    expect(screen.getByRole("button", { name: /expand outline panel/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /expand linked mentions panel/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand tags panel/i })).toBeInTheDocument();
  });
});

describe("RightRail — no-note-open empty states (D-07)", () => {
  beforeEach(() => {
    mockExpanded = true;
    mockWidth = 280;
    mockOutlinePanelExpanded = true;
    mockLinkedMentionsPanelExpanded = true;
    mockTagsPanelExpanded = true;
    mockOutlineHeightRatio = 0.34;
    mockLinkedMentionsHeightRatio = 0.34;
    mockUseBacklinks.mockReset();
    mockUseBacklinks.mockReturnValue({
      backlinks: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockUseTagBrowser.mockReset();
    mockUseTagBrowser.mockReturnValue({
      tags: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  it("no note open: Outline shows 'No headings', Linked mentions shows 'No backlinks found', Tags still renders", () => {
    render(<RightRail activeNoteId={null} />);
    expect(screen.getByTestId("mock-outline-panel")).toHaveTextContent("No headings");
    expect(screen.getByTestId("mock-linked-mentions-panel")).toHaveTextContent(
      "No backlinks found",
    );
    expect(screen.getByTestId("mock-tags-panel")).toBeInTheDocument();
  });
});
