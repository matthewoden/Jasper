import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SidebarSearchResultRow } from "./SidebarSearchResultRow";
import { usePaneStore } from "../lib/usePaneStore";
import type { SearchResult } from "../lib/searchApi";

const mockResult: SearchResult = {
  id: "abc-123",
  title: "My Test Note",
  path: "notes/inbox/my-test-note.md",
  excerpt_html: 'foo <mark>bar</mark> baz <script>alert(1)</script>',
  matching_tags: ["project", "work"],
  rank: -1.5,
  modified_at: "2026-01-01T00:00:00Z",
};

describe("SidebarSearchResultRow", () => {
  beforeEach(() => {
    usePaneStore.getState().clearAll();
  });

  it("clicking the row calls usePaneStore.getState().openInActivePane(result.id), not setActiveNote", () => {
    const openInActivePane = vi.fn();
    usePaneStore.setState({ openInActivePane });
    render(<SidebarSearchResultRow result={mockResult} />);
    const row = screen.getByRole("button", { name: "Open note: My Test Note" });
    fireEvent.click(row);
    expect(openInActivePane).toHaveBeenCalledWith("abc-123");
  });

  it("pressing Enter on the focused row calls openInActivePane(result.id)", () => {
    const openInActivePane = vi.fn();
    usePaneStore.setState({ openInActivePane });
    render(<SidebarSearchResultRow result={mockResult} />);
    const row = screen.getByRole("button", { name: "Open note: My Test Note" });
    fireEvent.keyDown(row, { key: "Enter" });
    expect(openInActivePane).toHaveBeenCalledWith("abc-123");
  });

  it("pressing Space on the focused row calls openInActivePane(result.id)", () => {
    const openInActivePane = vi.fn();
    usePaneStore.setState({ openInActivePane });
    render(<SidebarSearchResultRow result={mockResult} />);
    const row = screen.getByRole("button", { name: "Open note: My Test Note" });
    fireEvent.keyDown(row, { key: " " });
    expect(openInActivePane).toHaveBeenCalledWith("abc-123");
  });

  it("renders excerpt_html sanitized: <mark> preserved, <script> stripped", () => {
    const { container } = render(<SidebarSearchResultRow result={mockResult} />);
    const markEl = container.querySelector(".search-result-excerpt mark");
    expect(markEl).toBeTruthy();
    expect(markEl?.textContent).toBe("bar");
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("<script>");
  });

  it("renders matching tag pills only when matching_tags is non-empty", () => {
    render(<SidebarSearchResultRow result={mockResult} />);
    expect(screen.getByText("#project")).toBeDefined();
    expect(screen.getByText("#work")).toBeDefined();
  });

  it("does not render tag pills when matching_tags is empty", () => {
    const resultNoTags: SearchResult = { ...mockResult, matching_tags: [] };
    render(<SidebarSearchResultRow result={resultNoTags} />);
    expect(screen.queryByText(/^#/)).toBeNull();
  });

  it("renders title and path as plain text (no HTML injection)", () => {
    const maliciousResult: SearchResult = {
      ...mockResult,
      title: "<img src=x onerror=alert(1)>",
      path: "notes/<b>bold</b>.md",
    };
    const { container } = render(<SidebarSearchResultRow result={maliciousResult} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeDefined();
  });

  it("shows 12% accent highlight background when isSelected is true", () => {
    const { container } = render(<SidebarSearchResultRow result={mockResult} isSelected />);
    const row = container.querySelector('[role="button"]') as HTMLElement;
    expect(row.style.background).toContain("var(--color-accent)");
    expect(row.style.background).toContain("12%");
  });

  it("does not show the accent highlight background when isSelected is false", () => {
    const { container } = render(<SidebarSearchResultRow result={mockResult} isSelected={false} />);
    const row = container.querySelector('[role="button"]') as HTMLElement;
    expect(row.style.background).not.toContain("var(--color-accent)");
  });
});
