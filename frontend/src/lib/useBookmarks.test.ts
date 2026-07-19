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

vi.mock("./bookmarksApi", () => ({
  getBookmarks: (...args: unknown[]) => getBookmarksMock(...args),
  postBookmark: (...args: unknown[]) => postBookmarkMock(...args),
  deleteBookmark: (...args: unknown[]) => deleteBookmarkMock(...args),
  postBookmarkMove: (...args: unknown[]) => postBookmarkMoveMock(...args),
  postBookmarkFolder: (...args: unknown[]) => postBookmarkFolderMock(...args),
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
});
