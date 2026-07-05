/**
 * LinkedMentionsPanel tests — body-only card list (Phase 20 rename of
 * BacklinksRail, RSIDE-02).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockOpenTab = vi.fn();
vi.mock("../lib/useTabStore", () => ({
  useTabStore: {
    getState: () => ({ openTab: mockOpenTab }),
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

import { LinkedMentionsPanel } from "./LinkedMentionsPanel";

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
});

describe("LinkedMentionsPanel — empty states", () => {
  it("shows 'No backlinks found' when noteId is null", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<LinkedMentionsPanel noteId={null} />);
    expect(screen.getByText("No backlinks found")).toBeInTheDocument();
    expect(
      screen.getByText("Notes that link here with [[wiki-links]] will appear here."),
    ).toBeInTheDocument();
  });

  it("shows 'No backlinks found' when note is open but has zero backlinks", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<LinkedMentionsPanel noteId="some-note-id" />);
    expect(screen.getByText("No backlinks found")).toBeInTheDocument();
  });

  it("shows loading affordance while fetching", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: null,
      loading: true,
      error: null,
      refresh: vi.fn(),
    });

    render(<LinkedMentionsPanel noteId="some-note-id" />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows error message on fetch failure (no role=alert — avoids colliding with the app's migration-banner alert)", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: null,
      loading: false,
      error: new Error("network down"),
      refresh: vi.fn(),
    });

    render(<LinkedMentionsPanel noteId="some-note-id" />);
    expect(screen.getByText("network down")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("LinkedMentionsPanel — cards", () => {
  it("renders one card per linking note", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_A, ROW_B],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<LinkedMentionsPanel noteId="target-id" />);
    expect(document.querySelectorAll(".backlinks-row")).toHaveLength(2);
    expect(screen.getByText("Note A")).toBeInTheDocument();
    expect(screen.getByText("Note B")).toBeInTheDocument();
  });

  it("title click calls useTabStore openTab with sourceId (not setActiveNoteId)", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_A],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<LinkedMentionsPanel noteId="target-id" />);
    const titleBtn = screen.getByRole("button", { name: /open note: note a/i });
    fireEvent.click(titleBtn);
    expect(mockOpenTab).toHaveBeenCalledWith(ROW_A.sourceId);
  });

  it("title button color is var(--color-accent)", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_A],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<LinkedMentionsPanel noteId="target-id" />);
    const titleBtn = screen.getByRole("button", { name: /open note: note a/i });
    expect(titleBtn).toHaveStyle({ color: "var(--color-accent)" });
  });

  it("renders one stacked sanitized excerpt div per excerpt (multi-mention row)", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_B],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<LinkedMentionsPanel noteId="target-id" />);
    const excerptEls = document.querySelectorAll(".backlinks-excerpt");
    expect(excerptEls).toHaveLength(2);
    expect(excerptEls[0].innerHTML).toContain("first mention");
    expect(excerptEls[1].innerHTML).toContain("second mention");
  });

  it("sanitizeHtml is called once per excerpt, individually — never joined", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_A, ROW_B],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<LinkedMentionsPanel noteId="target-id" />);
    expect(mockSanitizeHtml).toHaveBeenCalledTimes(3);
    expect(mockSanitizeHtml).toHaveBeenCalledWith(ROW_A.excerpts[0]);
    expect(mockSanitizeHtml).toHaveBeenCalledWith(ROW_B.excerpts[0]);
    expect(mockSanitizeHtml).toHaveBeenCalledWith(ROW_B.excerpts[1]);
  });

  it("does NOT render a per-card count badge", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_B],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<LinkedMentionsPanel noteId="target-id" />);
    // The old `row.count > 1 && <span>·{count}</span>` badge is removed.
    expect(screen.queryByText(/·\s*\d+/)).toBeNull();
  });

  it("adds a border-bottom separator between cards but not after the last card", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [ROW_A, ROW_B],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<LinkedMentionsPanel noteId="target-id" />);
    const rows = document.querySelectorAll(".backlinks-row");
    expect(rows[0]).toHaveStyle({
      borderBottom: "1px solid var(--color-border-inner)",
    });
    expect((rows[1] as HTMLElement).style.borderBottom).toBe("");
  });
});

describe("LinkedMentionsPanel — no own header", () => {
  it("does not render a header row or × close button", () => {
    mockUseBacklinks.mockReturnValue({
      backlinks: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<LinkedMentionsPanel noteId={null} />);
    expect(document.querySelector("header")).toBeNull();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });
});
