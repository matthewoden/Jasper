/**
 * BacklinksRail tests — BR1..BR8
 *
 * Plan 06-11 / LINKS-08.
 *
 * Tests for the full data-wired backlinks rail (updated from Plan 06-07
 * chrome-only tests). Uses vi.mock for useBacklinks and sanitize.ts.
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
  excerpt: '<span>See <mark class="backlink-ref">[[Target]]</mark> here.</span>',
  count: 1,
};

const ROW_B = {
  sourceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  sourceTitle: "Note B",
  sourcePath: "notes/b.md",
  excerpt: '<span><mark class="backlink-ref">[[Target]]</mark> used twice.</span>',
  count: 2,
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


describe("BR6: count badge appears when count > 1", () => {
  it("renders count badge for ROW_B which has count=2", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_B],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<BacklinksRail noteId="target-id" />);
    expect(screen.getByText(/·2/)).toBeInTheDocument();
  });

  it("does NOT render count badge for ROW_A which has count=1", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_A],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<BacklinksRail noteId="target-id" />);
    expect(screen.queryByText(/·1/)).toBeNull();
  });
});


describe("BR7: sanitizeHtml called for every row excerpt", () => {
  it("calls sanitizeHtml once per row", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_A, ROW_B],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<BacklinksRail noteId="target-id" />);

    expect(mockSanitizeHtml).toHaveBeenCalledTimes(2);
    expect(mockSanitizeHtml).toHaveBeenCalledWith(ROW_A.excerpt);
    expect(mockSanitizeHtml).toHaveBeenCalledWith(ROW_B.excerpt);
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


describe("Header chrome (from Plan 06-07)", () => {
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


describe("Phase 6.6: BacklinksRail × close button (D-04)", () => {
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
