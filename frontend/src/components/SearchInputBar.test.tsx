import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SearchInputBar } from "./SearchInputBar";
import { useTreeStore } from "../lib/useTreeStore";

beforeEach(() => {
  useTreeStore.setState({
    searchQuery: "",
    searchActive: false,
    searchResults: [],
  });
});

describe("SearchInputBar", () => {
  it("renders a text input with correct placeholder and aria-label", () => {
    render(<SearchInputBar />);
    const input = screen.getByRole("textbox", { name: "Search notes" });
    expect(input).toBeDefined();
    expect((input as HTMLInputElement).placeholder).toBe("Search notes…");
  });

  it("renders the Search (lucide) icon — aria-hidden", () => {
    render(<SearchInputBar />);
    const container = screen.getByRole("textbox", { name: "Search notes" })
      .parentElement;
    expect(container?.querySelector("svg")).toBeTruthy();
  });

  it("does NOT show the clear button when input is empty", () => {
    render(<SearchInputBar />);
    expect(
      screen.queryByRole("button", { name: "Clear search" }),
    ).toBeNull();
  });

  it("calls setSearchQuery when user types", () => {
    render(<SearchInputBar />);
    const input = screen.getByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: "hello" } });
    expect(useTreeStore.getState().searchQuery).toBe("hello");
  });

  it("shows the clear button when searchQuery is non-empty", () => {
    useTreeStore.setState({ searchQuery: "hello" });
    render(<SearchInputBar />);
    expect(screen.getByRole("button", { name: "Clear search" })).toBeDefined();
  });

  it("clear button click resets searchQuery, searchActive, and searchResults", () => {
    useTreeStore.setState({
      searchQuery: "hello",
      searchActive: true,
      searchResults: [
        {
          id: "abc",
          title: "Test",
          path: "test.md",
          excerpt_html: "",
          matching_tags: [],
          rank: 0,
          modified_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    render(<SearchInputBar />);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    const state = useTreeStore.getState();
    expect(state.searchQuery).toBe("");
    expect(state.searchActive).toBe(false);
    expect(state.searchResults).toEqual([]);
  });

  it("pressing Esc clears the searchQuery", () => {
    useTreeStore.setState({ searchQuery: "hello" });
    render(<SearchInputBar />);
    const input = screen.getByRole("textbox", { name: "Search notes" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(useTreeStore.getState().searchQuery).toBe("");
  });
});
