/**
 * RightRail tests — Phase 30 tab-row + single-mounted-panel shell (TAGS-01,
 * D-01..D-05): RightRailTabRow at the top, exactly ONE of
 * Outline/LinkedMentions/RightRailTagsPanel mounted below it, driven by the
 * rightPanel slice. No independent per-section collapse/divider/ratio
 * machinery remains.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSetWidth = vi.fn();
const mockSetRightPanel = vi.fn();
const mockSetExpanded = vi.fn();

let mockExpanded = true;
let mockWidth = 280;
let mockRightPanel: "outline" | "backlinks" | "tags" = "outline";
let mockOutlineHeadingsCount = 0;

const mockStoreState = () => ({
  backlinksRailExpanded: mockExpanded,
  backlinksRailWidth: mockWidth,
  setBacklinksRailWidth: mockSetWidth,
  setBacklinksRailExpanded: mockSetExpanded,
  rightPanel: mockRightPanel,
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

vi.mock("../lib/useWorkspace", () => ({
  useWorkspace: () => ({
    notesSort: "name-asc",
    searchSort: "relevance",
    rightPanel: mockRightPanel,
    setNotesSort: vi.fn(),
    setSearchSort: vi.fn(),
    setRightPanel: mockSetRightPanel,
  }),
}));

const mockUseBacklinks = vi.fn();
vi.mock("../lib/useBacklinks", () => ({
  useBacklinks: (...args: unknown[]) => mockUseBacklinks(...args),
}));

let mockNoteTagsCount = 0;
vi.mock("../lib/useNoteTagsFromDoc", () => ({
  useNoteTagsStore: (selector: (s: { noteTags: string[] }) => unknown) =>
    selector({ noteTags: new Array(mockNoteTagsCount).fill("t") }),
}));

vi.mock("../lib/useOutlineStore", () => ({
  useOutlineStore: (selector: (s: { outlineHeadings: unknown[] }) => unknown) =>
    selector({ outlineHeadings: new Array(mockOutlineHeadingsCount).fill(0) }),
}));

const noteTagsSectionProps: unknown[] = [];
vi.mock("./NoteTagsSection", () => ({
  NoteTagsSection: (props: { activeNoteId: string | null }) => {
    noteTagsSectionProps.push(props);
    return (
      <div
        data-testid="mock-note-tags-section"
        data-noteid={props.activeNoteId ?? "null"}
      />
    );
  },
}));

vi.mock("./OutlinePanel", () => ({
  OutlinePanel: () => <div data-testid="mock-outline-panel">No headings</div>,
}));
const linkedMentionsPanelProps: unknown[] = [];
vi.mock("./LinkedMentionsPanel", () => ({
  LinkedMentionsPanel: (props: { noteId: string | null }) => {
    linkedMentionsPanelProps.push(props);
    return (
      <div
        data-testid="mock-linked-mentions-panel"
        data-noteid={props.noteId ?? "null"}
      >
        No backlinks found
      </div>
    );
  },
}));
vi.mock("./RightRailTagsPanel", () => ({
  RightRailTagsPanel: () => <div data-testid="mock-tags-panel">Tags Panel</div>,
}));

import { RightRail } from "./RightRail";

beforeEach(() => {
  mockExpanded = true;
  mockWidth = 280;
  mockRightPanel = "outline";
  mockOutlineHeadingsCount = 0;
  mockSetWidth.mockReset();
  mockSetRightPanel.mockReset();
  mockSetExpanded.mockReset();
  linkedMentionsPanelProps.length = 0;

  mockNoteTagsCount = 0;
  noteTagsSectionProps.length = 0;

  mockUseBacklinks.mockReset();
  mockUseBacklinks.mockReturnValue({
    backlinks: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
});

describe("RightRail — collapsed rail renders a slim single-control reopen strip (30-13)", () => {
  beforeEach(() => {
    mockExpanded = false;
  });

  it("when backlinksRailExpanded=false, RightRail renders a collapsed strip (not null)", () => {
    const { container } = render(<RightRail activeNoteId={null} />);
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByTestId("right-rail-collapsed")).toBeInTheDocument();
  });

  it("collapsed strip is RAIL_COLLAPSED_WIDTH wide", () => {
    render(<RightRail activeNoteId={null} />);
    const strip = screen.getByTestId("right-rail-collapsed");
    expect(strip).toHaveStyle({ width: "32px" });
  });

  it("collapsed strip renders exactly ONE reopen control (aria-label 'Show panels')", () => {
    render(<RightRail activeNoteId={null} />);
    const strip = screen.getByTestId("right-rail-collapsed");
    expect(within(strip).getAllByRole("button")).toHaveLength(1);
    expect(within(strip).getByLabelText("Show panels")).toBeInTheDocument();
  });

  it("clicking the collapsed strip's reopen control calls setBacklinksRailExpanded(true)", () => {
    render(<RightRail activeNoteId={null} />);
    fireEvent.click(screen.getByLabelText("Show panels"));
    expect(mockSetExpanded).toHaveBeenCalledWith(true);
  });

  it("does NOT render RightRailTabRow or any panel content while collapsed", () => {
    render(<RightRail activeNoteId={null} />);
    expect(screen.queryByTestId("right-rail-tab-row")).toBeNull();
  });

  it("style prop is merged onto the collapsed strip for grid placement", () => {
    const { container } = render(
      <RightRail activeNoteId={null} style={{ gridRow: "1 / 3", gridColumn: "4" }} />,
    );
    const strip = container.querySelector('[data-testid="right-rail-collapsed"]') as HTMLElement;
    expect(strip).toBeTruthy();
    expect(strip.style.gridRow).toBe("1 / 3");
    expect(strip.style.gridColumn).toBe("4");
  });
});

describe("RightRail — tab row + single-panel shell", () => {
  it("renders the RightRailTabRow icon-tab row", () => {
    render(<RightRail activeNoteId="note-1" />);
    expect(screen.getByTestId("right-rail-tab-row")).toBeInTheDocument();
  });

  it("rightPanel='outline' mounts ONLY OutlinePanel", () => {
    mockRightPanel = "outline";
    render(<RightRail activeNoteId="note-1" />);
    expect(screen.getByTestId("mock-outline-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-linked-mentions-panel")).toBeNull();
    expect(screen.queryByTestId("mock-tags-panel")).toBeNull();
    expect(screen.getByText("Outline")).toBeInTheDocument();
  });

  it("rightPanel='backlinks' mounts ONLY LinkedMentionsPanel", () => {
    mockRightPanel = "backlinks";
    mockUseBacklinks.mockReturnValue({
      backlinks: [{ sourceId: "a" }, { sourceId: "b" }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<RightRail activeNoteId="note-1" />);
    expect(screen.queryByTestId("mock-outline-panel")).toBeNull();
    expect(screen.getByTestId("mock-linked-mentions-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-tags-panel")).toBeNull();
    expect(screen.getByText("Linked mentions")).toBeInTheDocument();
  });

  it("rightPanel='tags' mounts ONLY the two Tags-tab sections (NoteTagsSection + RightRailTagsPanel)", () => {
    mockRightPanel = "tags";
    render(<RightRail activeNoteId="note-1" />);
    expect(screen.queryByTestId("mock-outline-panel")).toBeNull();
    expect(screen.queryByTestId("mock-linked-mentions-panel")).toBeNull();
    expect(screen.getByTestId("mock-note-tags-section")).toBeInTheDocument();
    expect(screen.getByTestId("mock-tags-panel")).toBeInTheDocument();
    expect(screen.getByText("Note tags")).toBeInTheDocument();
  });

  it("Tags tab passes activeNoteId through to NoteTagsSection", () => {
    mockRightPanel = "tags";
    render(<RightRail activeNoteId="note-42" />);
    expect(screen.getByTestId("mock-note-tags-section")).toHaveAttribute(
      "data-noteid",
      "note-42",
    );
  });

  it("LinkedMentionsPanel receives activeNoteId prop", () => {
    mockRightPanel = "backlinks";
    render(<RightRail activeNoteId="abc-123" />);
    expect(screen.getByTestId("mock-linked-mentions-panel")).toHaveAttribute(
      "data-noteid",
      "abc-123",
    );
  });

  it("fetches backlinks ONCE and passes the same rows to LinkedMentionsPanel (no duplicate useBacklinks instance)", () => {
    mockRightPanel = "backlinks";
    const rows = [{ sourceId: "a" }, { sourceId: "b" }];
    mockUseBacklinks.mockReturnValue({
      backlinks: rows,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<RightRail activeNoteId="note-1" />);

    expect(mockUseBacklinks).toHaveBeenCalledTimes(1);
    expect(mockUseBacklinks).toHaveBeenCalledWith("note-1");
    const last = linkedMentionsPanelProps.at(-1) as {
      backlinks: unknown;
      loading: boolean;
      error: Error | null;
    };
    expect(last.backlinks).toBe(rows);
    expect(last.loading).toBe(false);
    expect(last.error).toBeNull();
  });

  it("Linked-mentions sub-header shows the distinct-source count (backlinks.length)", () => {
    mockRightPanel = "backlinks";
    mockUseBacklinks.mockReturnValue({
      backlinks: [{ sourceId: "a" }, { sourceId: "b" }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<RightRail activeNoteId="note-1" />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("Note tags sub-header shows the active note's live tag count", () => {
    mockRightPanel = "tags";
    mockNoteTagsCount = 2;
    render(<RightRail activeNoteId="note-1" />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("Note tags sub-header shows 0 when no note is open (does not leak a stale count)", () => {
    mockRightPanel = "tags";
    mockNoteTagsCount = 5;
    render(<RightRail activeNoteId={null} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("Outline sub-header shows the heading count", () => {
    mockRightPanel = "outline";
    mockOutlineHeadingsCount = 3;
    render(<RightRail activeNoteId="note-1" />);
    expect(screen.getByText("3")).toBeInTheDocument();
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

  it("expanded rail background is --color-surface, flush (no inset padding), mock parity 23-03 D-06", () => {
    const { container } = render(<RightRail activeNoteId={null} />);
    const aside = container.querySelector("aside");
    expect(aside).toBeTruthy();
    const styleAttr = aside?.getAttribute("style") ?? "";
    expect(styleAttr).toContain("var(--color-surface)");
    expect(styleAttr).not.toContain("padding: 8px");
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

  it("no retired stacked-sections machinery remains — renders without any per-section collapse/divider mocks", () => {
    // Compile-time: RightRail no longer imports InterPanelDivider or the
    // per-section collapse booleans; runtime smoke check that rendering
    // succeeds with only the tab-row + single-panel mocks above.
    expect(() => render(<RightRail activeNoteId={null} />)).not.toThrow();
  });
});

describe("RightRail — no-note-open empty states", () => {
  beforeEach(() => {
    mockUseBacklinks.mockReturnValue({
      backlinks: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  it("no note open, Outline tab active: OutlinePanel still renders its own 'No headings' empty state", () => {
    mockRightPanel = "outline";
    render(<RightRail activeNoteId={null} />);
    expect(screen.getByTestId("mock-outline-panel")).toHaveTextContent("No headings");
  });

  it("no note open, Linked mentions tab active: LinkedMentionsPanel still renders its own 'No backlinks found' empty state", () => {
    mockRightPanel = "backlinks";
    render(<RightRail activeNoteId={null} />);
    expect(screen.getByTestId("mock-linked-mentions-panel")).toHaveTextContent(
      "No backlinks found",
    );
  });

  it("no note open, Tags tab active: RightRailTagsPanel still renders", () => {
    mockRightPanel = "tags";
    render(<RightRail activeNoteId={null} />);
    expect(screen.getByTestId("mock-tags-panel")).toBeInTheDocument();
  });
});
