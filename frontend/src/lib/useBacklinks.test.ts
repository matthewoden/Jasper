/**
 * useBacklinks tests — UB1..UB7
 *
 * Plan 06-11 / LINKS-08.
 *
 * Tests the reactive hook that drives the backlinks rail.
 */

import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


vi.mock("./backlinksApi", () => ({
  getNoteBacklinks: vi.fn(),
}));

import { getNoteBacklinks } from "./backlinksApi";
import { useBacklinks, __testing__ } from "./useBacklinks";

const mockGetNoteBacklinks = getNoteBacklinks as ReturnType<typeof vi.fn>;

const ROW_A = {
  sourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  sourceTitle: "Note A",
  sourcePath: "notes/a.md",
  excerpt: "<span>See <mark class=\"backlink-ref\">[[Target]]</mark> here.</span>",
  count: 1,
};

const ROW_B = {
  sourceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  sourceTitle: "Note B",
  sourcePath: "notes/b.md",
  excerpt: "<span><mark class=\"backlink-ref\">[[Target]]</mark> used twice.</span>",
  count: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetNoteBacklinks.mockResolvedValue([]);
});


describe("UB1: noteId=null returns stable null state", () => {
  it("returns { backlinks: null, loading: false, error: null } immediately", () => {
    const { result, unmount } = renderHook(() => useBacklinks(null));
    expect(result.current.backlinks).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockGetNoteBacklinks).not.toHaveBeenCalled();
    unmount();
    expect(__testing__.getSubscriberCount()).toBe(0);
  });
});


describe("UB2: noteId present triggers fetch; data populates", () => {
  it("starts with loading=true, resolves to data", async () => {
    mockGetNoteBacklinks.mockResolvedValue([ROW_A, ROW_B]);

    const { result, unmount } = renderHook(() =>
      useBacklinks("cccccccc-cccc-cccc-cccc-cccccccccccc"),
    );

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.backlinks).toEqual([ROW_A, ROW_B]);
    expect(result.current.error).toBeNull();
    expect(mockGetNoteBacklinks).toHaveBeenCalledWith(
      "cccccccc-cccc-cccc-cccc-cccccccccccc",
    );

    unmount();
    expect(__testing__.getSubscriberCount()).toBe(0);
  });
});


describe("UB3: changing noteId triggers a new fetch", () => {
  it("refetches when noteId changes", async () => {
    mockGetNoteBacklinks.mockResolvedValue([ROW_A]);

    const { result, rerender, unmount } = renderHook(
      ({ noteId }: { noteId: string }) => useBacklinks(noteId),
      { initialProps: { noteId: "aaaa-note-id" } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetNoteBacklinks).toHaveBeenCalledWith("aaaa-note-id");

    mockGetNoteBacklinks.mockResolvedValue([ROW_B]);
    rerender({ noteId: "bbbb-note-id" });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetNoteBacklinks).toHaveBeenCalledWith("bbbb-note-id");
    expect(result.current.backlinks).toEqual([ROW_B]);

    unmount();
    expect(__testing__.getSubscriberCount()).toBe(0);
  });
});


describe("UB4: error surfaces; stale data retained", () => {
  it("preserves previous backlinks on fetch error", async () => {
    mockGetNoteBacklinks.mockResolvedValue([ROW_A]);

    const { result, unmount } = renderHook(() => useBacklinks("note-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.backlinks).toEqual([ROW_A]);

    const fetchError = new Error("network failure");
    mockGetNoteBacklinks.mockRejectedValue(fetchError);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toEqual(fetchError);
    expect(result.current.backlinks).toEqual([ROW_A]);
    expect(result.current.loading).toBe(false);

    unmount();
    expect(__testing__.getSubscriberCount()).toBe(0);
  });
});


describe("UB5: refresh() re-fetches", () => {
  it("calling refresh() triggers a new fetch", async () => {
    mockGetNoteBacklinks.mockResolvedValue([ROW_A]);

    const { result, unmount } = renderHook(() =>
      useBacklinks("dddd-note-id"),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetNoteBacklinks).toHaveBeenCalledTimes(1);

    mockGetNoteBacklinks.mockResolvedValue([ROW_A, ROW_B]);

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockGetNoteBacklinks).toHaveBeenCalledTimes(2);
    expect(result.current.backlinks).toEqual([ROW_A, ROW_B]);

    unmount();
    expect(__testing__.getSubscriberCount()).toBe(0);
  });
});


describe("UB6: WS events note:updated, note:created, links:rewritten trigger refetch", () => {
  it.each(["note:updated", "note:created", "links:rewritten"] as const)(
    "dispatching %s refetches backlinks",
    async (event) => {
      mockGetNoteBacklinks.mockResolvedValue([ROW_A]);

      const { result, unmount } = renderHook(() =>
        useBacklinks("eeee-note-id"),
      );

      await waitFor(() => expect(result.current.loading).toBe(false));
      const callsBefore = mockGetNoteBacklinks.mock.calls.length;

      mockGetNoteBacklinks.mockResolvedValue([ROW_A, ROW_B]);

      act(() => {
        __testing__.simulateEvent(event);
      });

      await waitFor(() =>
        expect(mockGetNoteBacklinks.mock.calls.length).toBeGreaterThan(callsBefore),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.backlinks).toEqual([ROW_A, ROW_B]);

      unmount();
      expect(__testing__.getSubscriberCount()).toBe(0);
    },
  );
});


describe("UB7: WS event not targeted at current note still triggers refresh", () => {
  it("any links event causes refresh regardless of payload note id", async () => {
    mockGetNoteBacklinks.mockResolvedValue([ROW_A]);

    const { result, unmount } = renderHook(() =>
      useBacklinks("ffff-note-id"),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    const callsBefore = mockGetNoteBacklinks.mock.calls.length;

    mockGetNoteBacklinks.mockResolvedValue([ROW_A, ROW_B]);

    act(() => {
      __testing__.simulateEvent("note:updated");
    });

    await waitFor(() =>
      expect(mockGetNoteBacklinks.mock.calls.length).toBeGreaterThan(callsBefore),
    );

    unmount();
    expect(__testing__.getSubscriberCount()).toBe(0);
  });
});


afterEach(() => {
  expect(__testing__.getSubscriberCount()).toBe(0);
});
