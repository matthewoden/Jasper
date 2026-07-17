/**
 * LinkedMentionsPanel tests — body-only card list (Phase 20 rename of
 * BacklinksRail, RSIDE-02).
 *
 * Backlink data is passed as props (RightRail owns the single useBacklinks
 * fetch — WR-07), so tests drive states directly through props.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { BacklinkRow } from "../lib/backlinksApi";

const mockOpenInActivePane = vi.fn();
vi.mock("../lib/usePaneStore", () => ({
  usePaneStore: {
    getState: () => ({ openInActivePane: mockOpenInActivePane }),
  },
}));

const mockSanitizeHtml = vi.fn((s: string) => s);
vi.mock("../lib/sanitize", () => ({
  sanitizeHtml: (s: string) => mockSanitizeHtml(s),
}));

import { LinkedMentionsPanel } from "./LinkedMentionsPanel";

const ROW_A: BacklinkRow = {
  sourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  sourceTitle: "Note A",
  sourcePath: "notes/a.md",
  excerpts: ['<span>See <mark class="backlink-ref">[[Target]]</mark> here.</span>'],
};

const ROW_B: BacklinkRow = {
  sourceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  sourceTitle: "Note B",
  sourcePath: "notes/b.md",
  excerpts: [
    '<span><mark class="backlink-ref">[[Target]]</mark> first mention.</span>',
    '<span><mark class="backlink-ref">[[Target]]</mark> second mention.</span>',
  ],
};

function renderPanel(
  props: Partial<React.ComponentProps<typeof LinkedMentionsPanel>> = {},
) {
  return render(
    <LinkedMentionsPanel
      noteId={null}
      backlinks={null}
      loading={false}
      error={null}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LinkedMentionsPanel — empty states", () => {
  it("shows 'No backlinks found' when noteId is null", () => {
    renderPanel({ noteId: null, backlinks: null });
    expect(screen.getByText("No backlinks found")).toBeInTheDocument();
    expect(
      screen.getByText("Notes that link here with [[wiki-links]] will appear here."),
    ).toBeInTheDocument();
  });

  it("shows 'No backlinks found' when note is open but has zero backlinks", () => {
    renderPanel({ noteId: "some-note-id", backlinks: [] });
    expect(screen.getByText("No backlinks found")).toBeInTheDocument();
  });

  it("shows loading affordance while fetching", () => {
    renderPanel({ noteId: "some-note-id", backlinks: null, loading: true });
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows error message on fetch failure (no role=alert — avoids colliding with the app's migration-banner alert)", () => {
    renderPanel({
      noteId: "some-note-id",
      backlinks: null,
      error: new Error("network down"),
    });
    expect(screen.getByText("network down")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("LinkedMentionsPanel — cards", () => {
  it("renders one card per linking note", () => {
    renderPanel({ noteId: "target-id", backlinks: [ROW_A, ROW_B] });
    expect(document.querySelectorAll(".backlinks-row")).toHaveLength(2);
    expect(screen.getByText("Note A")).toBeInTheDocument();
    expect(screen.getByText("Note B")).toBeInTheDocument();
  });

  it("title click calls usePaneStore openInActivePane with sourceId (not setActiveNoteId)", () => {
    renderPanel({ noteId: "target-id", backlinks: [ROW_A] });
    const titleBtn = screen.getByRole("button", { name: /open note: note a/i });
    fireEvent.click(titleBtn);
    expect(mockOpenInActivePane).toHaveBeenCalledWith(ROW_A.sourceId);
  });

  it("title button color is var(--color-accent)", () => {
    renderPanel({ noteId: "target-id", backlinks: [ROW_A] });
    const titleBtn = screen.getByRole("button", { name: /open note: note a/i });
    expect(titleBtn).toHaveStyle({ color: "var(--color-accent)" });
  });

  it("renders one stacked sanitized excerpt div per excerpt (multi-mention row)", () => {
    renderPanel({ noteId: "target-id", backlinks: [ROW_B] });
    const excerptEls = document.querySelectorAll(".backlinks-excerpt");
    expect(excerptEls).toHaveLength(2);
    expect(excerptEls[0].innerHTML).toContain("first mention");
    expect(excerptEls[1].innerHTML).toContain("second mention");
  });

  it("sanitizeHtml is called once per excerpt, individually — never joined", () => {
    renderPanel({ noteId: "target-id", backlinks: [ROW_A, ROW_B] });
    expect(mockSanitizeHtml).toHaveBeenCalledTimes(3);
    expect(mockSanitizeHtml).toHaveBeenCalledWith(ROW_A.excerpts[0]);
    expect(mockSanitizeHtml).toHaveBeenCalledWith(ROW_B.excerpts[0]);
    expect(mockSanitizeHtml).toHaveBeenCalledWith(ROW_B.excerpts[1]);
  });

  it("does NOT render a per-card count badge", () => {
    renderPanel({ noteId: "target-id", backlinks: [ROW_B] });
    // The old `row.count > 1 && <span>·{count}</span>` badge is removed.
    expect(screen.queryByText(/·\s*\d+/)).toBeNull();
  });

  it("adds a border-bottom separator between cards but not after the last card", () => {
    renderPanel({ noteId: "target-id", backlinks: [ROW_A, ROW_B] });
    const rows = document.querySelectorAll(".backlinks-row");
    expect(rows[0]).toHaveStyle({
      borderBottom: "1px solid var(--color-border-inner)",
    });
    expect((rows[1] as HTMLElement).style.borderBottom).toBe("");
  });
});

describe("LinkedMentionsPanel — no own header", () => {
  it("does not render a header row or × close button", () => {
    renderPanel({ noteId: null, backlinks: [] });
    expect(document.querySelector("header")).toBeNull();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });
});
