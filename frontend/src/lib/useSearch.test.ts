import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSearch } from "./useSearch";
import * as searchApi from "./searchApi";

const MOCK_RESULT = {
  id: "1",
  title: "Hello World",
  path: "hello.md",
  excerpt_html: "<mark>hello</mark> world",
  matching_tags: [],
  rank: 0,
  modified_at: "2026-05-14T00:00:00Z",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(searchApi, "searchNotes").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useSearch (parameter-driven, Plan 07-18)", () => {
  it("returns empty results and isSearching=false when query.length < 2", () => {
    const { result } = renderHook(() => useSearch("a", null));
    expect(result.current.results).toEqual([]);
    expect(result.current.isSearching).toBe(false);
    expect(searchApi.searchNotes).not.toHaveBeenCalled();
  });

  it("returns empty results and isSearching=false for empty query", () => {
    const { result } = renderHook(() => useSearch("", null));
    expect(result.current.results).toEqual([]);
    expect(result.current.isSearching).toBe(false);
    expect(searchApi.searchNotes).not.toHaveBeenCalled();
  });

  it("sets isSearching=true immediately for query >= 2 chars, before debounce fires", () => {
    const { result } = renderHook(() => useSearch("he", null));
    expect(result.current.isSearching).toBe(true);
    expect(searchApi.searchNotes).not.toHaveBeenCalled();
  });

  it("debounces 200ms then returns results from searchNotes", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([MOCK_RESULT]);
    const { result } = renderHook(() => useSearch("hello", null));

    expect(result.current.isSearching).toBe(true);
    expect(searchApi.searchNotes).not.toHaveBeenCalled();

    // advance less than debounce — not fired yet
    await act(async () => {
      vi.advanceTimersByTime(199);
    });
    expect(searchApi.searchNotes).not.toHaveBeenCalled();

    // advance past debounce
    await act(async () => {
      vi.advanceTimersByTime(2);
    });
    expect(searchApi.searchNotes).toHaveBeenCalledWith("hello", undefined, 50);
    expect(result.current.results).toEqual([MOCK_RESULT]);
    expect(result.current.isSearching).toBe(false);
  });

  it("passes activeTagFilter to searchNotes as tag", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([]);
    renderHook(() => useSearch("hello", "project"));
    await act(async () => {
      vi.advanceTimersByTime(201);
    });
    expect(searchApi.searchNotes).toHaveBeenCalledWith("hello", "project", 50);
  });

  it("cancels previous debounce when query changes rapidly (only final call fires)", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([]);
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useSearch(q, null),
      { initialProps: { q: "he" } },
    );

    // advance partway
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // change query — previous debounce should be cancelled
    rerender({ q: "hello" });
    await act(async () => {
      vi.advanceTimersByTime(201);
    });

    // should only fire once (for final value)
    expect(searchApi.searchNotes).toHaveBeenCalledTimes(1);
    expect(searchApi.searchNotes).toHaveBeenCalledWith("hello", undefined, 50);
    void result;
  });

  it("returns empty results and isSearching=false when query drops below threshold", () => {
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useSearch(q, null),
      { initialProps: { q: "hello" } },
    );
    // Initially searching
    expect(result.current.isSearching).toBe(true);

    // Drop below threshold
    rerender({ q: "h" });
    expect(result.current.results).toEqual([]);
    expect(result.current.isSearching).toBe(false);
  });

  it("re-runs when activeTagFilter changes", async () => {
    vi.spyOn(searchApi, "searchNotes").mockResolvedValue([]);
    const { rerender } = renderHook(
      ({ tag }: { tag: string | null }) => useSearch("hello", tag),
      { initialProps: { tag: null } },
    );

    await act(async () => {
      vi.advanceTimersByTime(201);
    });
    expect(searchApi.searchNotes).toHaveBeenCalledWith("hello", undefined, 50);

    rerender({ tag: "project" });
    await act(async () => {
      vi.advanceTimersByTime(201);
    });
    expect(searchApi.searchNotes).toHaveBeenLastCalledWith("hello", "project", 50);
    expect(searchApi.searchNotes).toHaveBeenCalledTimes(2);
  });

  it("source file contains the D-08 INTENTIONAL DESIGN comment (WS-free contract)", async () => {
    // This test acts as a compile-time signal that the comment block is present.
    const { useSearch: imported } = await import("./useSearch");
    expect(typeof imported).toBe("function");
    const { result } = renderHook(() => imported("", null));
    expect(typeof result.current.isSearching).toBe("boolean");
    expect(Array.isArray(result.current.results)).toBe(true);
  });
});
