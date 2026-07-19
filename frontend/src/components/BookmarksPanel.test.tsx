/**
 * BookmarksPanel tests — Phase 27 Plan 06.
 *
 * Task 1: empty state, live-titled rows, open-in-active-pane, folder collapse.
 * Task 2 (appended below): "…" menu Remove/Move-to-folder, inline
 * "New bookmark folder" input, Sidebar wiring assertions live in Sidebar.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { ReactElement } from "react";

import { BookmarksPanel } from "./BookmarksPanel";
import { useTreeStore } from "../lib/useTreeStore";
import { usePaneStore } from "../lib/usePaneStore";
import type { Tree } from "../lib/treeApi";

const getBookmarksMock = vi.fn();
const postBookmarkMock = vi.fn();
const deleteBookmarkMock = vi.fn();
const postBookmarkMoveMock = vi.fn();
const postBookmarkFolderMock = vi.fn();

vi.mock("../lib/bookmarksApi", () => ({
  getBookmarks: (...args: unknown[]) => getBookmarksMock(...args),
  postBookmark: (...args: unknown[]) => postBookmarkMock(...args),
  deleteBookmark: (...args: unknown[]) => deleteBookmarkMock(...args),
  postBookmarkMove: (...args: unknown[]) => postBookmarkMoveMock(...args),
  postBookmarkFolder: (...args: unknown[]) => postBookmarkFolderMock(...args),
}));

const toastSpy = vi.fn();
vi.mock("../components/toast.utils", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

const mockUseFileTree = vi.fn();
vi.mock("../lib/useFileTree", () => ({
  useFileTree: () => mockUseFileTree(),
}));

const mockTree: Tree = {
  root: [
    {
      kind: "note",
      id: "note-a",
      path: "a.md",
      title: "Alpha Note",
    },
    {
      kind: "note",
      id: "note-b",
      path: "b.md",
      title: "Beta Note",
    },
  ],
} as unknown as Tree;

const bookmarkA = { id: "bm-1", note_id: "note-a", folder_id: null, order: 0 };
const bookmarkB = { id: "bm-2", note_id: "note-b", folder_id: "f-1", order: 0 };
const folder1 = { id: "f-1", name: "Work" };

/** Render + flush useBookmarks' mount-hydrate effect so it settles before assertions. */
async function renderPanel(ui: ReactElement) {
  const result = render(ui);
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

describe("BookmarksPanel", () => {
  beforeEach(() => {
    getBookmarksMock.mockReset().mockResolvedValue({ folders: [], bookmarks: [] });
    postBookmarkMock.mockReset();
    deleteBookmarkMock.mockReset();
    postBookmarkMoveMock.mockReset();
    postBookmarkFolderMock.mockReset();
    toastSpy.mockReset();
    mockUseFileTree.mockReset().mockReturnValue({
      tree: mockTree,
      loading: false,
      error: null,
      refresh: vi.fn(),
      mutate: vi.fn(),
    });
    useTreeStore.setState({ bookmarks: [], bookmarkFolders: [] });
    usePaneStore.setState({ openInActivePane: vi.fn() });
  });

  it("(a) renders BookmarksEmptyState when the slice is empty", async () => {
    await renderPanel(<BookmarksPanel />);
    expect(screen.getByTestId("bookmarks-empty-state")).toBeDefined();
  });

  it("(b) renders a row with the resolved title for a bookmarked note present in a mock tree", async () => {
    getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [bookmarkA] });
    await renderPanel(<BookmarksPanel />);
    expect(screen.getByText("Alpha Note")).toBeDefined();
  });

  it("does not render a bookmark whose note is absent from the loaded tree", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [],
      bookmarks: [bookmarkA, { id: "bm-3", note_id: "note-ghost", folder_id: null, order: 1 }],
    });
    await renderPanel(<BookmarksPanel />);
    expect(screen.getByText("Alpha Note")).toBeDefined();
    expect(screen.queryByTestId("bookmark-row-bm-3")).toBeNull();
  });

  it("(c) clicking a row calls openInActivePane with the noteId", async () => {
    const openInActivePane = vi.fn();
    usePaneStore.setState({ openInActivePane });
    getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [bookmarkA] });
    await renderPanel(<BookmarksPanel />);
    fireEvent.click(screen.getByText("Alpha Note"));
    expect(openInActivePane).toHaveBeenCalledWith("note-a");
  });

  it("(d) a folder row toggles its children's visibility on click", async () => {
    getBookmarksMock.mockResolvedValue({ folders: [folder1], bookmarks: [bookmarkB] });
    await renderPanel(<BookmarksPanel />);
    expect(screen.getByText("Beta Note")).toBeDefined();

    fireEvent.click(screen.getByTestId("bookmark-folder-f-1"));
    expect(screen.queryByText("Beta Note")).toBeNull();

    fireEvent.click(screen.getByTestId("bookmark-folder-f-1"));
    expect(screen.getByText("Beta Note")).toBeDefined();
  });

  it("renders top-level bookmarks and folder-nested bookmarks together", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [folder1],
      bookmarks: [bookmarkA, bookmarkB],
    });
    await renderPanel(<BookmarksPanel />);
    expect(screen.getByText("Alpha Note")).toBeDefined();
    expect(screen.getByText("Beta Note")).toBeDefined();
    expect(screen.getByText("Work")).toBeDefined();
  });
});
