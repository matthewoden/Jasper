/**
 * Tests for useBacklinks — the reactive hook that drives the backlinks rail.
 *
 * `backlinksResource` is built with the REAL `createKeyedResource` (not
 * mocked) so the resource layer's single-slot/coalescing/invalidation
 * semantics are exercised for real — only the network-facing
 * `getNoteBacklinks` fetcher is mocked via `./backlinksApi`.
 */

import { renderHook, act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetNoteBacklinks = vi.fn();

vi.mock("./backlinksApi", async () => {
  const { createKeyedResource } = await import("./resources/createResource");
  return {
    backlinksResource: createKeyedResource(
      "backlinks",
      (noteId: string) => mockGetNoteBacklinks(noteId),
      {
        mode: "cached",
        invalidatedBy: ["note:updated", "note:created", "links:rewritten"],
      },
    ),
  };
});

import { backlinksResource } from "./backlinksApi";
import { useBacklinks, __testing__ } from "./useBacklinks";
import { publish } from "./resources";

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
  mockGetNoteBacklinks.mockReset();
  mockGetNoteBacklinks.mockResolvedValue([]);
  // Per-entry reset (not the global registry reset): backlinksResource's
  // eventBus subscription is wired up at module-load time inside the
  // vi.mock factory above and must survive across tests, or the
  // note:updated/note:created/links:rewritten WS-invalidation cases below
  // would only work once. clear() resets every keyed entry's cached
  // data/hydrated/error without touching that subscription.
  backlinksResource.clear();
});


describe("UB1: noteId=null returns stable null state", () => {
  it("returns { backlinks: null, loading: false, error: null } immediately", () => {
    const { result, unmount } = renderHook(() => useBacklinks(null));
    expect(result.current.backlinks).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockGetNoteBacklinks).not.toHaveBeenCalled();
    unmount();
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
    expect(
      __testing__.getSubscriberCount("cccccccc-cccc-cccc-cccc-cccccccccccc"),
    ).toBe(0);
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
    expect(__testing__.getSubscriberCount("bbbb-note-id")).toBe(0);
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
    expect(__testing__.getSubscriberCount("note-1")).toBe(0);
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
    expect(__testing__.getSubscriberCount("dddd-note-id")).toBe(0);
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
      expect(__testing__.getSubscriberCount("eeee-note-id")).toBe(0);
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
    expect(__testing__.getSubscriberCount("ffff-note-id")).toBe(0);
  });
});


describe("UB8: tags:rewritten does NOT trigger a refetch (deliberate exclusion)", () => {
  it("dispatching tags:rewritten causes zero additional fetcher calls", async () => {
    mockGetNoteBacklinks.mockResolvedValue([ROW_A]);

    const { result, unmount } = renderHook(() =>
      useBacklinks("gggg-note-id"),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    const callsBefore = mockGetNoteBacklinks.mock.calls.length;

    // tags:rewritten is intentionally NOT in backlinksResource's
    // invalidatedBy list — publishing it must not touch this resource.
    // Publish directly on the real event bus (not __testing__.simulateEvent,
    // which only publishes the three included events) to prove the exclusion.
    act(() => {
      publish("tags:rewritten");
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(mockGetNoteBacklinks.mock.calls.length).toBe(callsBefore);

    unmount();
  });
});


describe("UB9: switching noteId evicts the previous note's entry (single-slot)", () => {
  it("A to B evicts A's cache entry; returning to A refetches", async () => {
    mockGetNoteBacklinks.mockImplementation((id: string) =>
      Promise.resolve(id === "note-A" ? [ROW_A] : [ROW_B]),
    );

    const { result, rerender, unmount } = renderHook(
      ({ noteId }: { noteId: string }) => useBacklinks(noteId),
      { initialProps: { noteId: "note-A" } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.backlinks).toEqual([ROW_A]);

    rerender({ noteId: "note-B" });
    await waitFor(() => expect(result.current.backlinks).toEqual([ROW_B]));

    // A's slot was evicted on B's 0->1 subscribe — the entry no
    // longer exists at all, not merely stale.
    expect(
      backlinksResource.forKey("note-A").peek().hydrated,
    ).toBe(false);

    const callsBeforeReturn = mockGetNoteBacklinks.mock.calls.length;
    rerender({ noteId: "note-A" });
    await waitFor(() => expect(result.current.backlinks).toEqual([ROW_A]));
    expect(mockGetNoteBacklinks.mock.calls.length).toBeGreaterThan(
      callsBeforeReturn,
    );

    unmount();
  });
});
