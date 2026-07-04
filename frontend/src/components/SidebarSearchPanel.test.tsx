import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SidebarSearchPanel } from "./SidebarSearchPanel";
import { useTreeStore } from "../lib/useTreeStore";
import { useTabStore } from "../lib/useTabStore";
import { dispatchPhase7 } from "../lib/appShortcuts";
import * as searchApi from "./../lib/searchApi";
import type { SearchResult } from "../lib/searchApi";

const mkResult = (id: string, title: string): SearchResult => ({
  id,
  title,
  path: `notes/${title}.md`,
  excerpt_html: `<mark>${title}</mark>`,
  matching_tags: [],
  rank: -1,
  modified_at: "2026-01-01T00:00:00Z",
});

beforeEach(() => {
  vi.useFakeTimers();
  useTreeStore.setState({ searchQuery: "", searchResults: [] });
  useTabStore.setState({ tabs: [], activeTabId: null });
  vi.spyOn(searchApi, "searchNotes").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SidebarSearchPanel", () => {
  it("renders the input with the exact contract placeholder", () => {
    render(<SidebarSearchPanel onSelectNote={() => {}} />);
    expect(
      screen.getByPlaceholderText("Search notes… (tag:name to filter)"),
    ).toBeDefined();
  });

  it("shows the quiet hint when the query is empty", () => {
    render(<SidebarSearchPanel onSelectNote={() => {}} />);
    expect(screen.getByText("Search your notes")).toBeDefined();
  });

  it("fires no searchNotes call and shows the quiet hint for a <2-char free-text query", async () => {
    render(<SidebarSearchPanel onSelectNote={() => {}} />);
    const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
    fireEvent.change(input, { target: { value: "a" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(searchApi.searchNotes).not.toHaveBeenCalled();
    expect(screen.getByText("Search your notes")).toBeDefined();
  });

  it("debounces a >=2-char query and fires exactly one searchNotes call after settle", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([mkResult("1", "Hello")]);
    render(<SidebarSearchPanel onSelectNote={() => {}} />);
    const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
    fireEvent.change(input, { target: { value: "hello" } });

    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(searchApi.searchNotes).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(searchApi.searchNotes).toHaveBeenCalledTimes(1);
    expect(searchApi.searchNotes).toHaveBeenCalledWith("hello", undefined, 50);
  });

  it("parses tag: terms and calls searchNotes(text, tags, limit)", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([]);
    render(<SidebarSearchPanel onSelectNote={() => {}} />);
    const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
    fireEvent.change(input, { target: { value: "tag:work budget" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(searchApi.searchNotes).toHaveBeenCalledWith("budget", ["work"], 50);
  });

  it("shows the singular-aware count label with results", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([mkResult("1", "Hello")]);
    render(<SidebarSearchPanel onSelectNote={() => {}} />);
    const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
    fireEvent.change(input, { target: { value: "hello" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("1 result")).toBeDefined();
  });

  it("shows the plural count label with multiple results", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([
      mkResult("1", "Hello"),
      mkResult("2", "World"),
    ]);
    render(<SidebarSearchPanel onSelectNote={() => {}} />);
    const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
    fireEvent.change(input, { target: { value: "hello" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("2 results")).toBeDefined();
  });

  it('shows "No matches for ..." when a >=2-char query returns zero results', async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([]);
    render(<SidebarSearchPanel onSelectNote={() => {}} />);
    const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
    fireEvent.change(input, { target: { value: "zzz" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText('No matches for "zzz"')).toBeDefined();
  });

  it("ArrowDown/ArrowUp move the highlighted index within bounds; Enter opens via openTab", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([
      mkResult("1", "Hello"),
      mkResult("2", "World"),
    ]);
    const openTab = vi.fn();
    useTabStore.setState({ openTab });
    render(<SidebarSearchPanel onSelectNote={() => {}} />);
    const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
    fireEvent.change(input, { target: { value: "hello" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    // ArrowUp at idx 0 stays clamped at 0
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(openTab).toHaveBeenCalledWith("2");
  });

  it("first Escape (non-empty query) clears the query and results", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([mkResult("1", "Hello")]);
    render(<SidebarSearchPanel onSelectNote={() => {}} />);
    const input = screen.getByPlaceholderText(
      "Search notes… (tag:name to filter)",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(useTreeStore.getState().searchQuery).toBe("");
    expect(useTreeStore.getState().searchResults).toEqual([]);
  });

  it("second Escape (empty query) blurs the input", () => {
    render(<SidebarSearchPanel onSelectNote={() => {}} />);
    const input = screen.getByPlaceholderText(
      "Search notes… (tag:name to filter)",
    ) as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).not.toBe(input);
  });

  it("dispatching the focusSearch phase7 event focuses the input and selects existing text", () => {
    useTreeStore.setState({ searchQuery: "hello" });
    render(<SidebarSearchPanel onSelectNote={() => {}} />);
    const input = screen.getByPlaceholderText(
      "Search notes… (tag:name to filter)",
    ) as HTMLInputElement;
    const selectSpy = vi.spyOn(input, "select");
    act(() => {
      dispatchPhase7("focusSearch");
    });
    expect(document.activeElement).toBe(input);
    expect(selectSpy).toHaveBeenCalled();
  });

  it("persists query + results in the store across unmount/remount (D-18)", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([mkResult("1", "Hello")]);
    const { unmount } = render(<SidebarSearchPanel onSelectNote={() => {}} />);
    const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
    fireEvent.change(input, { target: { value: "hello" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    unmount();

    expect(useTreeStore.getState().searchQuery).toBe("hello");
    expect(useTreeStore.getState().searchResults.length).toBe(1);

    render(<SidebarSearchPanel onSelectNote={() => {}} />);
    const remountedInput = screen.getByPlaceholderText(
      "Search notes… (tag:name to filter)",
    ) as HTMLInputElement;
    expect(remountedInput.value).toBe("hello");
    expect(screen.getByText("1 result")).toBeDefined();
  });
});
