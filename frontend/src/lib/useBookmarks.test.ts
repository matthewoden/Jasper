/**
 * Tests for useBookmarks hook.
 * Covers mount hydrate, WS-triggered refresh (dispatchBookmarksEvent /
 * __testing__.simulateEvent), and toggleBookmark add/remove for the same
 * noteId — the entry-point-agnostic seam other plans (06, 07) hang off.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

const getBookmarksMock = vi.fn();
const postBookmarkMock = vi.fn();
const deleteBookmarkMock = vi.fn();
const postBookmarkMoveMock = vi.fn();
const postBookmarkFolderMock = vi.fn();
const reorderBookmarksMock = vi.fn();

vi.mock("./bookmarksApi", () => ({
  getBookmarks: (...args: unknown[]) => getBookmarksMock(...args),
  postBookmark: (...args: unknown[]) => postBookmarkMock(...args),
  deleteBookmark: (...args: unknown[]) => deleteBookmarkMock(...args),
  postBookmarkMove: (...args: unknown[]) => postBookmarkMoveMock(...args),
  postBookmarkFolder: (...args: unknown[]) => postBookmarkFolderMock(...args),
  reorderBookmarks: (...args: unknown[]) => reorderBookmarksMock(...args),
}));

const toastSpy = vi.fn();
vi.mock("../components/toast.utils", () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: ReactNode }) => children,
}));

import { useTreeStore } from "./useTreeStore";
import {
  useBookmarks,
  __testing__,
  dispatchBookmarksEvent,
} from "./useBookmarks";

const bookmarkA = {
  id: "bm-1",
  note_id: "note-a",
  folder_id: null,
  order: 0,
};

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement("div", null, children);

describe("useBookmarks", () => {
  beforeEach(() => {
    getBookmarksMock.mockReset();
    postBookmarkMock.mockReset();
    deleteBookmarkMock.mockReset();
    postBookmarkMoveMock.mockReset();
    postBookmarkFolderMock.mockReset();
    reorderBookmarksMock.mockReset();
    toastSpy.mockReset();
    useTreeStore.setState({ bookmarks: [], bookmarkFolders: [] });
  });

  it("B1: mount calls getBookmarks once and populates the store", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [],
      bookmarks: [bookmarkA],
    });

    const { result } = renderHook(() => useBookmarks(), { wrapper });

    await waitFor(() => {
      expect(result.current.bookmarks).toEqual([bookmarkA]);
    });
    expect(getBookmarksMock).toHaveBeenCalledTimes(1);
  });

  it("B2: dispatchBookmarksEvent triggers a refetch in every mounted session", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [],
      bookmarks: [bookmarkA],
    });

    const { result } = renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.bookmarks).toEqual([bookmarkA]));

    getBookmarksMock.mockResolvedValue({
      folders: [],
      bookmarks: [
        bookmarkA,
        { id: "bm-2", note_id: "note-b", folder_id: null, order: 1 },
      ],
    });

    act(() => {
      dispatchBookmarksEvent();
    });

    await waitFor(() => {
      expect(getBookmarksMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.bookmarks.length).toBe(2);
    });
  });

  it("B3: __testing__.simulateEvent also drives a refetch", async () => {
    getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [] });

    const { result } = renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.bookmarks).toEqual([]));

    act(() => {
      __testing__.simulateEvent();
    });

    await waitFor(() => {
      expect(getBookmarksMock).toHaveBeenCalledTimes(2);
    });
  });

  it("B4: toggleBookmark adds when absent, then removes when present (same noteId)", async () => {
    getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [] });

    const { result } = renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.bookmarks).toEqual([]));

    postBookmarkMock.mockResolvedValueOnce(bookmarkA);
    await act(async () => {
      await result.current.toggleBookmark("note-a");
    });

    expect(result.current.bookmarks).toEqual([bookmarkA]);
    expect(postBookmarkMock).toHaveBeenCalledWith("note-a");

    deleteBookmarkMock.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.toggleBookmark("note-a");
    });

    expect(result.current.bookmarks).toEqual([]);
    expect(deleteBookmarkMock).toHaveBeenCalledWith("bm-1");
  });

  it("B17: sequential toggleBookmark calls for two distinct notes accumulate in the store (CTX-02 bulk-bookmark clobber fix)", async () => {
    getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [] });

    const { result } = renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.bookmarks).toEqual([]));

    const bookmarkB = {
      id: "bm-2",
      note_id: "note-b",
      folder_id: null,
      order: 1,
    };
    postBookmarkMock.mockResolvedValueOnce(bookmarkA);
    postBookmarkMock.mockResolvedValueOnce(bookmarkB);

    await act(async () => {
      await result.current.toggleBookmark("note-a");
    });
    await act(async () => {
      await result.current.toggleBookmark("note-b");
    });

    expect(result.current.bookmarks).toEqual(
      expect.arrayContaining([bookmarkA, bookmarkB]),
    );
    expect(result.current.bookmarks.length).toBe(2);
  });

  it("B5: toggleBookmark add failure reverts the optimistic entry and toasts", async () => {
    getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [] });

    const { result } = renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.bookmarks).toEqual([]));

    postBookmarkMock.mockRejectedValueOnce(new Error("backend went away"));
    await act(async () => {
      await result.current.toggleBookmark("note-a");
    });

    expect(result.current.bookmarks).toEqual([]);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't add bookmark",
        variant: "error",
      }),
    );
  });

  it("B6: toggleBookmark remove failure reverts the optimistic removal and toasts", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [],
      bookmarks: [bookmarkA],
    });

    const { result } = renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.bookmarks).toEqual([bookmarkA]));

    deleteBookmarkMock.mockRejectedValueOnce(new Error("backend went away"));
    await act(async () => {
      await result.current.toggleBookmark("note-a");
    });

    expect(result.current.bookmarks).toEqual([bookmarkA]);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't remove bookmark",
        variant: "error",
      }),
    );
  });

  it("B9: rapid double-toggle for the same noteId ignores the second call while the first is in flight (WR-07)", async () => {
    getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [] });

    const { result } = renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.bookmarks).toEqual([]));

    let resolvePost!: (value: typeof bookmarkA) => void;
    const pending = new Promise<typeof bookmarkA>((resolve) => {
      resolvePost = resolve;
    });
    postBookmarkMock.mockReturnValueOnce(pending);

    await act(async () => {
      const first = result.current.toggleBookmark("note-a");
      // Rapid second click before the first network call resolves — under
      // the pre-fix behavior this would target the "pending-note-a"
      // placeholder and race a DELETE against the in-flight POST.
      const second = result.current.toggleBookmark("note-a");
      resolvePost(bookmarkA);
      await Promise.all([first, second]);
    });

    // Only the first toggle's mutation should have gone out; the second
    // call was ignored while a mutation for the same noteId was in flight.
    expect(postBookmarkMock).toHaveBeenCalledTimes(1);
    expect(deleteBookmarkMock).not.toHaveBeenCalled();
    expect(result.current.bookmarks).toEqual([bookmarkA]);
  });

  it("B10: after an in-flight add resolves, toggling the same noteId again is honored (not permanently locked out)", async () => {
    getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [] });

    const { result } = renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.bookmarks).toEqual([]));

    postBookmarkMock.mockResolvedValueOnce(bookmarkA);
    await act(async () => {
      await result.current.toggleBookmark("note-a");
    });
    expect(result.current.bookmarks).toEqual([bookmarkA]);

    deleteBookmarkMock.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.toggleBookmark("note-a");
    });
    expect(result.current.bookmarks).toEqual([]);
    expect(deleteBookmarkMock).toHaveBeenCalledWith("bm-1");
  });

  it("B7: createFolder calls postBookmarkFolder and refreshes", async () => {
    getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [] });

    const { result } = renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.bookmarks).toEqual([]));

    postBookmarkFolderMock.mockResolvedValueOnce({ id: "f-1", name: "Work" });
    getBookmarksMock.mockResolvedValueOnce({
      folders: [{ id: "f-1", name: "Work" }],
      bookmarks: [],
    });

    await act(async () => {
      await result.current.createFolder("Work");
    });

    expect(postBookmarkFolderMock).toHaveBeenCalledWith("Work");
    await waitFor(() => {
      expect(result.current.bookmarkFolders).toEqual([
        { id: "f-1", name: "Work" },
      ]);
    });
  });

  it("B11: initial hydrate failure surfaces error=true and loading=false (27-UI-REVIEW #1)", async () => {
    getBookmarksMock.mockRejectedValue(new Error("backend unreachable"));

    const { result } = renderHook(() => useBookmarks(), { wrapper });

    await waitFor(() => {
      expect(result.current.error).toBe(true);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.bookmarks).toEqual([]);
  });

  it("B12: successful hydrate sets error=false and loading=false", async () => {
    getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [bookmarkA] });

    const { result } = renderHook(() => useBookmarks(), { wrapper });

    await waitFor(() => {
      expect(result.current.bookmarks).toEqual([bookmarkA]);
    });
    expect(result.current.error).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it("B13: a transient refresh failure AFTER a successful hydrate does not regress error or wipe the cache", async () => {
    getBookmarksMock.mockResolvedValueOnce({ folders: [], bookmarks: [bookmarkA] });

    const { result } = renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.bookmarks).toEqual([bookmarkA]));
    expect(result.current.error).toBe(false);

    getBookmarksMock.mockRejectedValueOnce(new Error("transient hiccup"));
    act(() => {
      dispatchBookmarksEvent();
    });

    await waitFor(() => {
      expect(getBookmarksMock).toHaveBeenCalledTimes(2);
    });
    expect(result.current.error).toBe(false);
    expect(result.current.bookmarks).toEqual([bookmarkA]);
  });

  it("B14: retrying refresh() after an initial-hydrate failure clears the error on success", async () => {
    getBookmarksMock.mockRejectedValueOnce(new Error("backend unreachable"));

    const { result } = renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.error).toBe(true));

    getBookmarksMock.mockResolvedValueOnce({ folders: [], bookmarks: [bookmarkA] });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBe(false);
    expect(result.current.bookmarks).toEqual([bookmarkA]);
  });

  it("B8: moveToFolder calls postBookmarkMove and refreshes", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [],
      bookmarks: [bookmarkA],
    });

    const { result } = renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.bookmarks).toEqual([bookmarkA]));

    postBookmarkMoveMock.mockResolvedValueOnce({ id: "bm-1", folder_id: "f-1" });
    getBookmarksMock.mockResolvedValueOnce({
      folders: [],
      bookmarks: [{ ...bookmarkA, folder_id: "f-1" }],
    });

    await act(async () => {
      await result.current.moveToFolder("bm-1", "f-1");
    });

    expect(postBookmarkMoveMock).toHaveBeenCalledWith("bm-1", "f-1");
    await waitFor(() => {
      expect(result.current.bookmarks[0].folder_id).toBe("f-1");
    });
  });

  it("B15: reorder optimistically reassigns Order for the given scope and calls reorderBookmarks", async () => {
    const bookmarkC = { id: "bm-3", note_id: "note-c", folder_id: null, order: 2 };
    getBookmarksMock.mockResolvedValue({
      folders: [],
      bookmarks: [bookmarkA, { id: "bm-2", note_id: "note-b", folder_id: null, order: 1 }, bookmarkC],
    });

    const { result } = renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.bookmarks.length).toBe(3));

    reorderBookmarksMock.mockResolvedValueOnce(undefined);
    getBookmarksMock.mockResolvedValueOnce({
      folders: [],
      bookmarks: [
        { ...bookmarkC, order: 0 },
        { ...bookmarkA, order: 1 },
        { id: "bm-2", note_id: "note-b", folder_id: null, order: 2 },
      ],
    });

    await act(async () => {
      await result.current.reorder(null, ["bm-3", "bm-1", "bm-2"]);
    });

    expect(reorderBookmarksMock).toHaveBeenCalledWith(null, ["bm-3", "bm-1", "bm-2"]);
    await waitFor(() => {
      const byId = Object.fromEntries(result.current.bookmarks.map((b) => [b.id, b.order]));
      expect(byId).toEqual({ "bm-3": 0, "bm-1": 1, "bm-2": 2 });
    });
  });

  it("B16: reorder failure reverts the optimistic order and toasts", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [],
      bookmarks: [bookmarkA, { id: "bm-2", note_id: "note-b", folder_id: null, order: 1 }],
    });

    const { result } = renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.bookmarks.length).toBe(2));

    reorderBookmarksMock.mockRejectedValueOnce(new Error("backend went away"));
    await act(async () => {
      await result.current.reorder(null, ["bm-2", "bm-1"]);
    });

    expect(result.current.bookmarks[0].id).toBe("bm-1");
    expect(result.current.bookmarks[0].order).toBe(0);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't reorder bookmarks",
        variant: "error",
      }),
    );
  });
});
