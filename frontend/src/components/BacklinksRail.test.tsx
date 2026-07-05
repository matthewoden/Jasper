/**
 * BacklinksRail tests — BR1..BR8
 *
 * Uses vi.mock for useBacklinks and sanitize.ts.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";


const mockSetExpanded = vi.fn();
const mockSetActiveNote = vi.fn();
const mockSetPanelSelector = vi.fn();

vi.mock("../lib/useTreeStore", () => ({
  useTreeStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state: Record<string, unknown> = {
      setBacklinksRailExpanded: mockSetExpanded,
      setActiveNote: mockSetActiveNote,
      setPanelSelector: mockSetPanelSelector,
    };
    return selector(state);
  },
}));


const mockUseBacklinks = vi.fn();
vi.mock("../lib/useBacklinks", () => ({
  useBacklinks: (...args: unknown[]) => mockUseBacklinks(...args),
}));


const mockSanitizeHtml = vi.fn((s: string) => s);
vi.mock("../lib/sanitize", () => ({
  sanitizeHtml: (s: string) => mockSanitizeHtml(s),
}));

import { BacklinksRail } from "./BacklinksRail";

const ROW_A = {
  sourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  sourceTitle: "Note A",
  sourcePath: "notes/a.md",
  excerpts: ['<span>See <mark class="backlink-ref">[[Target]]</mark> here.</span>'],
};

const ROW_B = {
  sourceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  sourceTitle: "Note B",
  sourcePath: "notes/b.md",
  excerpts: [
    '<span><mark class="backlink-ref">[[Target]]</mark> first mention.</span>',
    '<span><mark class="backlink-ref">[[Target]]</mark> second mention.</span>',
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseBacklinks.mockReturnValue({
    backlinks: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  mockSetPanelSelector.mockReset();
});


describe("BR1: noteId=null renders empty state", () => {
  it("shows 'No notes link here yet.' when noteId is null", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<BacklinksRail noteId={null} />);
    expect(screen.getByText(/no notes link here yet/i)).toBeInTheDocument();
  });

  it("does not call getNoteBacklinks when noteId is null (useBacklinks receives null)", () => {
    render(<BacklinksRail noteId={null} />);
    expect(mockUseBacklinks).toHaveBeenCalledWith(null);
  });
});


describe("BR2: loading state shows affordance", () => {
  it("renders loading text while backlinks are being fetched", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: null,
      loading: true,
      error: null,
      refresh: vi.fn(),
    });

    render(<BacklinksRail noteId="some-note-id" />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});


describe("BR3: 0 backlinks shows 'No notes link here yet.'", () => {
  it("renders empty state when note is open but has no backlinks", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<BacklinksRail noteId="some-note-id" />);
    expect(screen.getByText(/no notes link here yet/i)).toBeInTheDocument();
  });
});


describe("BR4: each row renders source title + excerpt via dangerouslySetInnerHTML", () => {
  it("renders row with note title and excerpt", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_A],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<BacklinksRail noteId="target-id" />);
    expect(screen.getByText("Note A")).toBeInTheDocument();
    const excerptEl = document.querySelector(".backlinks-excerpt");
    expect(excerptEl).not.toBeNull();
    expect(excerptEl?.innerHTML).toContain("[[Target]]");
  });
});


describe("BR5: clicking source title sets active note", () => {
  it("calls setActiveNote with source id on title click", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_A],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<BacklinksRail noteId="target-id" />);
    const titleBtn = screen.getByRole("button", { name: /open note: note a/i });
    fireEvent.click(titleBtn);
    expect(mockSetActiveNote).toHaveBeenCalledWith(ROW_A.sourceId);
  });
});


describe("BR6: multiple excerpts render as stacked lines (D-16 per-mention excerpts)", () => {
  it("renders one .backlinks-excerpt element per excerpt for a multi-mention row", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_B],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<BacklinksRail noteId="target-id" />);
    const excerptEls = document.querySelectorAll(".backlinks-excerpt");
    expect(excerptEls).toHaveLength(2);
    expect(excerptEls[0].innerHTML).toContain("first mention");
    expect(excerptEls[1].innerHTML).toContain("second mention");
  });

  it("renders exactly one .backlinks-excerpt element for a single-mention row", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_A],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<BacklinksRail noteId="target-id" />);
    expect(document.querySelectorAll(".backlinks-excerpt")).toHaveLength(1);
  });
});


describe("BR7: sanitizeHtml called for every excerpt, individually (never joined)", () => {
  it("calls sanitizeHtml once per excerpt across all rows", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_A, ROW_B],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<BacklinksRail noteId="target-id" />);

    expect(mockSanitizeHtml).toHaveBeenCalledTimes(3);
    expect(mockSanitizeHtml).toHaveBeenCalledWith(ROW_A.excerpts[0]);
    expect(mockSanitizeHtml).toHaveBeenCalledWith(ROW_B.excerpts[0]);
    expect(mockSanitizeHtml).toHaveBeenCalledWith(ROW_B.excerpts[1]);
  });
});


describe("BR8: rows have backlinks-row CSS class for hover background", () => {
  it("each row li has class backlinks-row", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_A, ROW_B],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<BacklinksRail noteId="target-id" />);
    const rows = document.querySelectorAll(".backlinks-row");
    expect(rows).toHaveLength(2);
  });
});


describe("Header chrome", () => {
  it("renders 'Linked from' header", () => {
    render(<BacklinksRail noteId={null} />);
    expect(screen.getByText(/linked from/i)).toBeInTheDocument();
  });

  it("renders region with aria-label", () => {
    render(<BacklinksRail noteId={null} />);
    const region = screen.getByRole("region", {
      name: /notes that link to this note/i,
    });
    expect(region).toBeInTheDocument();
  });

  it("UAT 2026-05-12: rail-level 'Hide backlinks panel' chevron button is removed", () => {
    render(<BacklinksRail noteId={null} />);
    expect(screen.queryByRole("button", { name: /hide backlinks panel/i })).toBeNull();
  });
});


describe("BacklinksRail × close button", () => {
  it("BR-6.6-1: header contains a button with aria-label='Close Backlinks panel'", () => {
    render(<BacklinksRail noteId={null} />);
    const closeBtn = screen.getByRole("button", { name: /close backlinks panel/i });
    expect(closeBtn).toBeInTheDocument();
  });

  it("BR-6.6-2: clicking × calls setPanelSelector({ backlinks: false })", () => {
    render(<BacklinksRail noteId={null} />);
    const closeBtn = screen.getByRole("button", { name: /close backlinks panel/i });
    fireEvent.click(closeBtn);
    expect(mockSetPanelSelector).toHaveBeenCalledWith({ backlinks: false });
  });

  it("BR-6.6-3: × button has Lucide X icon (aria-hidden svg child)", () => {
    render(<BacklinksRail noteId={null} />);
    const closeBtn = screen.getByRole("button", { name: /close backlinks panel/i });
    const svg = closeBtn.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });
});
