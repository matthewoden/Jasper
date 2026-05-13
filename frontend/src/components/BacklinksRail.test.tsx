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

// ── Mocks set up before importing the component ──────────────────────────────

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

// Mock useBacklinks so we control the state.
const mockUseBacklinks = vi.fn();
vi.mock("../lib/useBacklinks", () => ({
  useBacklinks: (...args: unknown[]) => mockUseBacklinks(...args),
}));

// Mock sanitize.ts so BR7 can assert call count.
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
  // Default: empty state.
  mockUseBacklinks.mockReturnValue({
    backlinks: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  mockSetPanelSelector.mockReset();
});

// ─── BR1: noteId=null shows empty state ──────────────────────────────────────

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

// ─── BR2: loading state ───────────────────────────────────────────────────────

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

// ─── BR3: 0 results → empty state ────────────────────────────────────────────

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

// ─── BR4: row renders title + sanitized excerpt ───────────────────────────────

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
    // Excerpt is rendered as HTML; check for the text inside the mark.
    const excerptEl = document.querySelector(".backlinks-excerpt");
    expect(excerptEl).not.toBeNull();
    expect(excerptEl?.innerHTML).toContain("[[Target]]");
  });
});

// ─── BR5: click title sets active note ───────────────────────────────────────

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

// ─── BR6: count badge when N > 1 ─────────────────────────────────────────────

describe("BR6: count badge appears when count > 1", () => {
  it("renders count badge for ROW_B which has count=2", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_B],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<BacklinksRail noteId="target-id" />);
    // Badge text is "·2" (middot + count).
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

// ─── BR7: sanitize.ts called for every row excerpt ───────────────────────────

describe("BR7: sanitizeHtml called for every row excerpt", () => {
  it("calls sanitizeHtml once per row", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_A, ROW_B],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<BacklinksRail noteId="target-id" />);

    // sanitizeHtml should be called once per row (two rows → two calls).
    expect(mockSanitizeHtml).toHaveBeenCalledTimes(2);
    expect(mockSanitizeHtml).toHaveBeenCalledWith(ROW_A.excerpt);
    expect(mockSanitizeHtml).toHaveBeenCalledWith(ROW_B.excerpt);
  });
});

// ─── BR8: hover background via CSS class ─────────────────────────────────────

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

// ─── Header / hide button (preserved from Plan 06-07 chrome tests) ───────────

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
    // The rail collapses automatically when all panels are deselected
    // (RightRail useEffect). Clicking × on the only visible panel collapses
    // the rail; there is no longer a dedicated rail-collapse chevron.
    render(<BacklinksRail noteId={null} />);
    expect(screen.queryByRole("button", { name: /hide backlinks panel/i })).toBeNull();
  });
});

// ─── Phase 6.6 (Plan 06.6-11) — Per-panel × close button (D-04) ─────────────

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
    // The X Lucide icon is an SVG inside the button
    const svg = closeBtn.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });
});
