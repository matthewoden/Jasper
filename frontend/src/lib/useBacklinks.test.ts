/**
 * useBacklinks tests — UB1..UB7
 *
 * Plan 06-11 / LINKS-08.
 *
 * Tests the reactive hook that drives the backlinks rail.
 */

import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the API module before importing the hook.
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

// ─── UB1: noteId=null ────────────────────────────────────────────────────────

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

// ─── UB2: noteId present — fetch and populate ────────────────────────────────

describe("UB2: noteId present triggers fetch; data populates", () => {
  it("starts with loading=true, resolves to data", async () => {
    mockGetNoteBacklinks.mockResolvedValue([ROW_A, ROW_B]);

    const { result, unmount } = renderHook(() =>
      useBacklinks("cccccccc-cccc-cccc-cccc-cccccccccccc"),
    );

    // Loading starts immediately.
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

// ─── UB3: noteId change triggers refetch ─────────────────────────────────────

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

// ─── UB4: error surfaces; previous data retained ─────────────────────────────

describe("UB4: error surfaces; stale data retained", () => {
  it("preserves previous backlinks on fetch error", async () => {
    mockGetNoteBacklinks.mockResolvedValue([ROW_A]);

    const { result, unmount } = renderHook(() => useBacklinks("note-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.backlinks).toEqual([ROW_A]);

    // Simulate error on next fetch.
    const fetchError = new Error("network failure");
    mockGetNoteBacklinks.mockRejectedValue(fetchError);

    // Trigger a refresh (mimics a WS event).
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toEqual(fetchError);
    // Data is preserved — not cleared on error.
    expect(result.current.backlinks).toEqual([ROW_A]);
    expect(result.current.loading).toBe(false);

    unmount();
    expect(__testing__.getSubscriberCount()).toBe(0);
  });
});

// ─── UB5: refresh() works ────────────────────────────────────────────────────

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

// ─── UB6: WS events trigger refetch ─────────────────────────────────────────

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

// ─── UB7: WS event from unrelated note still triggers refresh ────────────────

describe("UB7: WS event not targeted at current note still triggers refresh", () => {
  it("any links event causes refresh regardless of payload note id", async () => {
    // The subscriber pattern refreshes unconditionally — any save anywhere
    // could have added/removed a [[...]] reference to the currently open note.
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

// ─── Subscriber cleanup guard ─────────────────────────────────────────────────

afterEach(() => {
  // Belt-and-suspenders: ensure no lingering subscribers after each test.
  // Each test's unmount() call should have already cleared them.
  // If this fires, a test is missing its unmount() call.
  expect(__testing__.getSubscriberCount()).toBe(0);
});
