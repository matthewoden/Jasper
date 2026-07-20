import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SidebarSearchPanel } from "./SidebarSearchPanel";
import { ToastProvider } from "./Toast";
import { useTreeStore } from "../lib/useTreeStore";
import { usePaneStore } from "../lib/usePaneStore";
import { dispatchPhase7 } from "../lib/appShortcuts";
import * as searchApi from "./../lib/searchApi";
import type { SearchResult } from "../lib/searchApi";

vi.mock("../lib/workspaceApi", () => ({
  getWorkspace: vi.fn().mockResolvedValue({}),
  putWorkspace: vi.fn().mockResolvedValue({}),
}));

const mkResult = (id: string, title: string): SearchResult => ({
  id,
  title,
  path: `notes/${title}.md`,
  excerpt_html: `<mark>${title}</mark>`,
  matching_tags: [],
  rank: -1,
  modified_at: "2026-01-01T00:00:00Z",
});

function renderPanel() {
  return render(
    <ToastProvider>
      <SidebarSearchPanel onSelectNote={() => {}} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  useTreeStore.setState({ searchQuery: "", searchResults: [], searchSort: "relevance" });
  usePaneStore.getState().clearAll();
  vi.spyOn(searchApi, "searchNotes").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SidebarSearchPanel", () => {
  it("renders the input with the exact contract placeholder", () => {
    renderPanel();
    expect(
      screen.getByPlaceholderText("Search notes… (tag:name to filter)"),
    ).toBeDefined();
  });

  it("shows the quiet hint when the query is empty", () => {
    renderPanel();
    expect(screen.getByText("Search your notes")).toBeDefined();
  });

  it("fires no searchNotes call and shows the quiet hint for a <2-char free-text query", async () => {
    renderPanel();
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
    renderPanel();
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
    expect(searchApi.searchNotes).toHaveBeenCalledWith("hello", undefined, 50, "relevance");
  });

  it("parses tag: terms and calls searchNotes(text, tags, limit, sort)", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([]);
    renderPanel();
    const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
    fireEvent.change(input, { target: { value: "tag:work budget" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(searchApi.searchNotes).toHaveBeenCalledWith("budget", ["work"], 50, "relevance");
  });

  it("re-fetches with the new sort when searchSort changes", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([]);
    renderPanel();
    const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
    fireEvent.change(input, { target: { value: "hello" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(searchApi.searchNotes).toHaveBeenLastCalledWith("hello", undefined, 50, "relevance");

    act(() => {
      useTreeStore.getState().setSearchSort("modified");
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(searchApi.searchNotes).toHaveBeenLastCalledWith("hello", undefined, 50, "modified");
  });

  it("shows the singular-aware count label with results", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([mkResult("1", "Hello")]);
    renderPanel();
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
    renderPanel();
    const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
    fireEvent.change(input, { target: { value: "hello" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("2 results")).toBeDefined();
  });

  it('shows "No matches for ..." when a >=2-char query returns zero results', async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([]);
    renderPanel();
    const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
    fireEvent.change(input, { target: { value: "zzz" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText('No matches for "zzz"')).toBeDefined();
  });

  it("ArrowDown/ArrowUp move the highlighted index within bounds; Enter opens via openInActivePane", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([
      mkResult("1", "Hello"),
      mkResult("2", "World"),
    ]);
    const openInActivePane = vi.fn();
    usePaneStore.setState({ openInActivePane });
    renderPanel();
    const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
    fireEvent.change(input, { target: { value: "hello" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    // ArrowUp at idx 0 stays clamped at 0
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(openInActivePane).toHaveBeenCalledWith("2");
  });

  it("first Escape (non-empty query) clears the query and results", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([mkResult("1", "Hello")]);
    renderPanel();
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
    renderPanel();
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
    renderPanel();
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
    const { unmount } = renderPanel();
    const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
    fireEvent.change(input, { target: { value: "hello" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    unmount();

    expect(useTreeStore.getState().searchQuery).toBe("hello");
    expect(useTreeStore.getState().searchResults.length).toBe(1);

    renderPanel();
    const remountedInput = screen.getByPlaceholderText(
      "Search notes… (tag:name to filter)",
    ) as HTMLInputElement;
    expect(remountedInput.value).toBe("hello");
    expect(screen.getByText("1 result")).toBeDefined();
  });
});
