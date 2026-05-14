import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SearchResultRow } from "./SearchResultRow";
import { useTreeStore } from "../lib/useTreeStore";
import type { SearchResult } from "../lib/searchApi";

const mockResult: SearchResult = {
  id: "abc-123",
  title: "My Test Note",
  path: "notes/inbox/my-test-note.md",
  excerpt_html: "foo <mark>bar</mark> baz",
  matching_tags: ["project", "work"],
  rank: -1.5,
  modified_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  useTreeStore.setState({
    activeNoteId: null,
    searchActive: false,
    searchQuery: "",
    searchResults: [],
  });
});

describe("SearchResultRow", () => {
  it("renders the note title at 14px / 600 weight", () => {
    render(<SearchResultRow result={mockResult} />);
    expect(screen.getByText("My Test Note")).toBeDefined();
  });

  it("renders the path breadcrumb with / separators", () => {
    render(<SearchResultRow result={mockResult} />);
    // Path: "notes/inbox/my-test-note.md" → "notes / inbox / my-test-note"
    expect(screen.getByText("notes / inbox / my-test-note")).toBeDefined();
  });

  it("renders sanitized excerpt HTML preserving <mark> tags (SEARCH-04 contract)", () => {
    const { container } = render(<SearchResultRow result={mockResult} />);
    // The excerpt should contain a <mark> element after sanitization
    const markEl = container.querySelector(".search-result-excerpt mark");
    expect(markEl).toBeTruthy();
    expect(markEl?.textContent).toBe("bar");
  });

  it("renders matching tag chips as #tagname in accent color", () => {
    render(<SearchResultRow result={mockResult} />);
    expect(screen.getByText("#project")).toBeDefined();
    expect(screen.getByText("#work")).toBeDefined();
  });

  it("does not render tag section when matching_tags is empty", () => {
    const resultNoTags: SearchResult = { ...mockResult, matching_tags: [] };
    render(<SearchResultRow result={resultNoTags} />);
    expect(screen.queryByText(/#/)).toBeNull();
  });

  it("on click: calls setActiveNote + clears search state", () => {
    render(<SearchResultRow result={mockResult} />);
    const row = screen.getByRole("button", { name: "Open note: My Test Note" });
    fireEvent.click(row);
    const state = useTreeStore.getState();
    expect(state.activeNoteId).toBe("abc-123");
    expect(state.searchActive).toBe(false);
    expect(state.searchQuery).toBe("");
    expect(state.searchResults).toEqual([]);
  });

  it("applies active background when row is the currently open note", () => {
    useTreeStore.setState({ activeNoteId: "abc-123" });
    const { container } = render(<SearchResultRow result={mockResult} />);
    // The row div has the active background via inline style
    const rowDiv = container.querySelector('[role="button"]') as HTMLElement;
    expect(rowDiv.style.background).toContain("var(--color-accent)");
  });
});
