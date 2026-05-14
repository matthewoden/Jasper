import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SearchResultsList } from "./SearchResultsList";
import { useTreeStore } from "../lib/useTreeStore";
import type { SearchResult } from "../lib/searchApi";

// Mock @tanstack/react-virtual for unit tests (no real DOM measurement).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        key: `item-${i}`,
        start: i * 80,
        size: 80,
      })),
    getTotalSize: () => count * 80,
    measureElement: () => {},
  }),
}));

function makeResult(id: string, title: string): SearchResult {
  return {
    id,
    title,
    path: `${title.toLowerCase().replace(/ /g, "-")}.md`,
    excerpt_html: `excerpt for <mark>${title}</mark>`,
    matching_tags: [],
    rank: -1.0,
    modified_at: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  useTreeStore.setState({
    searchQuery: "",
    searchResults: [],
    searchActive: false,
    activeNoteId: null,
  });
});

describe("SearchResultsList", () => {
  it("renders nothing (no results, short query) when query < 2 chars", () => {
    useTreeStore.setState({ searchQuery: "a", searchResults: [] });
    const { container } = render(<SearchResultsList />);
    // No empty state message — query too short
    expect(screen.queryByText(/No matches/)).toBeNull();
    // Container should be the empty-state-less path (no list either)
    expect(container.textContent).toBe("");
  });

  it("shows empty state when query >= 2 chars and no results", () => {
    useTreeStore.setState({ searchQuery: "he", searchResults: [] });
    render(<SearchResultsList />);
    expect(screen.getByText('No matches for "he"')).toBeDefined();
  });

  it("renders a row for each search result", () => {
    const results = [
      makeResult("1", "Alpha"),
      makeResult("2", "Beta"),
      makeResult("3", "Gamma"),
    ];
    useTreeStore.setState({ searchQuery: "al", searchResults: results });
    render(<SearchResultsList />);
    // getAllByText because title text also appears in the excerpt_html
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Beta").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Gamma").length).toBeGreaterThan(0);
  });

  it("does NOT show footer when results < 50", () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeResult(`${i}`, `Note ${i}`),
    );
    useTreeStore.setState({ searchQuery: "note", searchResults: results });
    render(<SearchResultsList />);
    expect(screen.queryByText(/Showing 50 of/)).toBeNull();
  });

  it("shows footer 'Showing 50 of ...' when results === 50 (hasMore=true)", () => {
    const results = Array.from({ length: 50 }, (_, i) =>
      makeResult(`${i}`, `Note ${i}`),
    );
    useTreeStore.setState({ searchQuery: "note", searchResults: results });
    render(<SearchResultsList />);
    expect(screen.getByText(/Showing 50 of/)).toBeDefined();
    expect(screen.getByText(/refine your search/)).toBeDefined();
  });
});
