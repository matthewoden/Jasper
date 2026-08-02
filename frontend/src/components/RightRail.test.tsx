/**
 * RightRail tests — tab-row + single-mounted-panel shell (TAGS-01;
 * The Tags tab is a single vault-wide list
 * and retired all panel sub-headers/counts): RightRailTabRow at the top,
 * exactly ONE of Outline/LinkedMentions/RightRailTagsPanel mounted below
 * it, driven by the rightPanel slice. No independent per-section
 * collapse/divider/ratio machinery remains.
 */
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { TooltipProvider } from "./Tooltip";

/** Every RightRail render is wrapped in TooltipProvider — RightRailTabRow's
 *  tab buttons now migrate to the shared Tooltip. */
function render(ui: ReactElement) {
  return rtlRender(<TooltipProvider>{ui}</TooltipProvider>);
}

const mockSetWidth = vi.fn();
const mockSetRightPanel = vi.fn();
const mockSetExpanded = vi.fn();

let mockExpanded = true;
let mockWidth = 280;
let mockRightPanel: "outline" | "backlinks" | "tags" = "outline";

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
  mockSetWidth.mockReset();
  mockSetRightPanel.mockReset();
  mockSetExpanded.mockReset();
  linkedMentionsPanelProps.length = 0;

  mockUseBacklinks.mockReset();
  mockUseBacklinks.mockReturnValue({
    backlinks: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
});

describe("RightRail — collapsed rail unmounts to 0 width (260721-cjt)", () => {
  beforeEach(() => {
    mockExpanded = false;
  });

  it("when backlinksRailExpanded=false, RightRail renders null (flush editor, no collapsed strip)", () => {
    const { container } = render(<RightRail activeNoteId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("does not render the legacy right-rail-collapsed strip testid", () => {
    render(<RightRail activeNoteId={null} />);
    expect(screen.queryByTestId("right-rail-collapsed")).toBeNull();
  });

  it("does not render a 'Show panels' button inside the rail", () => {
    render(<RightRail activeNoteId={null} />);
    expect(screen.queryByLabelText("Show panels")).toBeNull();
  });

  it("does NOT render RightRailTabRow or any panel content while collapsed", () => {
    render(<RightRail activeNoteId={null} />);
    expect(screen.queryByTestId("right-rail-tab-row")).toBeNull();
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
  });

  it("rightPanel='tags' mounts ONLY RightRailTagsPanel (single-list, no upper note-tags section)", () => {
    mockRightPanel = "tags";
    render(<RightRail activeNoteId="note-1" />);
    expect(screen.queryByTestId("mock-outline-panel")).toBeNull();
    expect(screen.queryByTestId("mock-linked-mentions-panel")).toBeNull();
    expect(screen.getByTestId("mock-tags-panel")).toBeInTheDocument();
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

  it("expanded rail still has vertical resize handle", () => {
    render(<RightRail activeNoteId={null} />);
    const separators = screen.getAllByRole("separator");
    const verticalHandle = separators.find(
      (s) => s.getAttribute("aria-orientation") === "vertical",
    );
    expect(verticalHandle).toBeDefined();
    expect(verticalHandle).toHaveAttribute("aria-label", "Resize backlinks panel");
  });

  it("expanded rail background is --color-surface, flush (no inset padding), mock parity", () => {
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

  it.each(["outline", "backlinks", "tags"] as const)(
    "rightPanel='%s' renders no in-panel sub-header (retired app-wide)",
    (panel) => {
      mockRightPanel = panel;
      render(<RightRail activeNoteId="note-1" />);
      expect(screen.queryByText("Outline")).toBeNull();
      expect(screen.queryByText("Linked mentions")).toBeNull();
      expect(screen.queryByText("Note tags")).toBeNull();
    },
  );
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
