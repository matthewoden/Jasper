import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, createEvent } from "@testing-library/react";
import { SidebarSearchPanel } from "./SidebarSearchPanel";
import { ToastProvider } from "./Toast";
import { useTreeStore } from "../lib/useTreeStore";
import { usePaneStore } from "../lib/usePaneStore";
import { dispatchPhase7 } from "../lib/appShortcuts";
import * as searchApi from "./../lib/searchApi";
import type { SearchResult } from "../lib/searchApi";
import {
  initForVault as initSearchHistoryForVault,
  getHistory,
  recordSearchHistory,
} from "../lib/searchHistory";

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
  // searchHistory is a module-level singleton (not a zustand store) — reset it
  // per test so recordSearchHistory calls in one test don't leak hint matches
  // into a later test's SearchHistoryHints render.
  window.localStorage.clear();
  initSearchHistoryForVault("/test-vault");
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
    act(() => {
      input.focus();
    });
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

  describe("search history (HIST-01/02)", () => {
    it("focusing the input opens the hints layer when history has prefix-matches", () => {
      recordSearchHistory("hello world");
      renderPanel();
      const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
      act(() => {
        input.focus();
      });
      expect(screen.getByRole("listbox", { name: "Recent searches" })).toBeDefined();
      expect(screen.getByRole("option", { name: /hello world/ })).toBeDefined();
    });

    it("does NOT record history from the debounced fetch effect", async () => {
      vi.spyOn(searchApi, "searchNotes").mockResolvedValue([mkResult("1", "Hello")]);
      renderPanel();
      const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
      fireEvent.change(input, { target: { value: "hello" } });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(getHistory()).toEqual([]);
    });

    it("Enter-opens-result records the committed query into history", async () => {
      vi.spyOn(searchApi, "searchNotes").mockResolvedValue([mkResult("1", "Hello")]);
      const openInActivePane = vi.fn();
      usePaneStore.setState({ openInActivePane });
      renderPanel();
      const input = screen.getByPlaceholderText("Search notes… (tag:name to filter)");
      fireEvent.change(input, { target: { value: "hello" } });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(openInActivePane).toHaveBeenCalledWith("1");
      expect(getHistory()).toEqual(["hello"]);
    });

    it("while hints are open with matches, ArrowDown/Enter act on the hint and results nav is suspended", () => {
      recordSearchHistory("hello world");
      const openInActivePane = vi.fn();
      usePaneStore.setState({ openInActivePane });
      renderPanel();
      const input = screen.getByPlaceholderText(
        "Search notes… (tag:name to filter)",
      ) as HTMLInputElement;
      act(() => {
        input.focus();
      });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(input.value).toBe("hello world");
      expect(openInActivePane).not.toHaveBeenCalled();
      expect(getHistory()[0]).toBe("hello world");
    });

    it("Enter-committing a result closes the hints layer instead of reopening it over the results (WR-02)", async () => {
      vi.spyOn(searchApi, "searchNotes").mockResolvedValue([
        mkResult("1", "Hello"),
        mkResult("2", "World"),
      ]);
      const openInActivePane = vi.fn();
      usePaneStore.setState({ openInActivePane });
      renderPanel();
      const input = screen.getByPlaceholderText(
        "Search notes… (tag:name to filter)",
      ) as HTMLInputElement;
      act(() => {
        input.focus(); // hintsOpen=true; history empty so no dropdown yet
      });
      fireEvent.change(input, { target: { value: "hello" } });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // Commit the search. The just-recorded "hello" prefix-matches itself,
      // so without an explicit close the dropdown reopens over the input
      // and hijacks the arrow keys from results nav.
      fireEvent.keyDown(input, { key: "Enter" });
      expect(openInActivePane).toHaveBeenLastCalledWith("1");
      expect(screen.queryByRole("listbox", { name: "Recent searches" })).toBeNull();

      // Arrows must still drive results nav: ArrowDown + Enter opens the
      // SECOND result, not a hint re-selection of "hello".
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(openInActivePane).toHaveBeenLastCalledWith("2");
    });

    // CR-02: replay the real browser event order for a mouse click on the
    // dropdown — mousedown (focus leaves the input unless default-prevented,
    // firing blur and queueing the 0ms close timer) … mouseup → click. jsdom's
    // bare fireEvent.click skips the focus cycle and false-passes, so these
    // tests drive the sequence explicitly and only skip the blur when the
    // component default-prevented the mousedown (what a browser would do).
    function mouseDownThenBlurThenClick(target: HTMLElement, input: HTMLElement) {
      const md = createEvent.mouseDown(target, { bubbles: true, cancelable: true });
      fireEvent(target, md);
      if (!md.defaultPrevented) {
        fireEvent.blur(input);
        act(() => {
          vi.advanceTimersByTime(0);
        });
      }
      fireEvent.click(target);
    }

    it("clicking a hint row survives the mousedown→blur→click browser sequence (CR-02)", () => {
      recordSearchHistory("hello world");
      renderPanel();
      const input = screen.getByPlaceholderText(
        "Search notes… (tag:name to filter)",
      ) as HTMLInputElement;
      act(() => {
        input.focus();
      });
      const row = screen.getByRole("option", { name: /hello world/ });
      mouseDownThenBlurThenClick(row, input);
      expect(useTreeStore.getState().searchQuery).toBe("hello world");
    });

    it("clicking a hint's remove-X survives the mousedown→blur→click browser sequence (D-21)", () => {
      recordSearchHistory("hello world");
      renderPanel();
      const input = screen.getByPlaceholderText(
        "Search notes… (tag:name to filter)",
      ) as HTMLInputElement;
      act(() => {
        input.focus();
      });
      const x = screen.getByLabelText('Remove "hello world" from search history');
      mouseDownThenBlurThenClick(x, input);
      expect(getHistory()).toEqual([]);
    });

    it("Esc while hints are open dismisses hints only; a second Esc runs the existing clear/blur behavior", () => {
      recordSearchHistory("hello world");
      renderPanel();
      const input = screen.getByPlaceholderText(
        "Search notes… (tag:name to filter)",
      ) as HTMLInputElement;
      act(() => {
        input.focus();
      });
      expect(screen.getByRole("listbox", { name: "Recent searches" })).toBeDefined();

      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("listbox", { name: "Recent searches" })).toBeNull();
      // First Escape dismissed hints only — did not blur or clear the (empty) query.
      expect(document.activeElement).toBe(input);

      fireEvent.keyDown(input, { key: "Escape" });
      expect(document.activeElement).not.toBe(input);
    });
  });
});
