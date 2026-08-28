/**
 * Reproduction for "creating a bookmark folder creates two folders".
 *
 * A single submit posts exactly once — the duplicate is not a double
 * invocation. The panel gates on `bookmarks.length === 0` alone, so a folder
 * created while no note is bookmarked never renders: the input closes, the
 * empty state stays, and nothing tells the user the folder exists. Repeating
 * the action is what produces the second folder.
 *
 * Lives in its own file so the sibling stories editing BookmarksPanel.test.tsx
 * do not collide with it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

import { BookmarksPanel } from "./BookmarksPanel";
import { TooltipProvider } from "./Tooltip";
import { useTreeStore } from "../lib/useTreeStore";
import { usePaneStore } from "../lib/usePaneStore";
import { bookmarksResource } from "../lib/bookmarksApi";
import type { Tree } from "../lib/treeApi";

const getBookmarksMock = vi.fn();
const postBookmarkMock = vi.fn();
const deleteBookmarkMock = vi.fn();
const postBookmarkMoveMock = vi.fn();
const postBookmarkFolderMock = vi.fn();
const reorderBookmarksMock = vi.fn();

vi.mock("../lib/bookmarksApi", async () => {
  const { createResource } = await import("../lib/resources/createResource");
  return {
    bookmarksResource: createResource("bookmarks", () => getBookmarksMock(), {
      mode: "cached",
      invalidatedBy: ["bookmark:changed"],
    }),
    postBookmark: (...args: unknown[]) => postBookmarkMock(...args),
    deleteBookmark: (...args: unknown[]) => deleteBookmarkMock(...args),
    postBookmarkMove: (...args: unknown[]) => postBookmarkMoveMock(...args),
    postBookmarkFolder: (...args: unknown[]) => postBookmarkFolderMock(...args),
    reorderBookmarks: (...args: unknown[]) => reorderBookmarksMock(...args),
  };
});

const toastSpy = vi.fn();
vi.mock("../components/toast.utils", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

const mockUseFileTree = vi.fn();
vi.mock("../lib/useFileTree", () => ({
  useFileTree: () => mockUseFileTree(),
}));

const mockTree: Tree = {
  root: [{ kind: "note", id: "note-a", path: "a.md", title: "Alpha Note" }],
} as unknown as Tree;

describe("BookmarksPanel — a new folder with no bookmarks yet", () => {
  beforeEach(() => {
    getBookmarksMock
      .mockReset()
      .mockResolvedValue({ folders: [], bookmarks: [] });
    postBookmarkMock.mockReset();
    deleteBookmarkMock.mockReset();
    postBookmarkMoveMock.mockReset();
    postBookmarkFolderMock.mockReset();
    reorderBookmarksMock.mockReset();
    toastSpy.mockReset();
    bookmarksResource.clear();
    mockUseFileTree.mockReset().mockReturnValue({
      tree: mockTree,
      loading: false,
      error: null,
      refresh: vi.fn(),
      mutate: vi.fn(),
    });
    useTreeStore.setState({ activeNoteId: null });
    usePaneStore.setState({ openInActivePane: vi.fn() });
  });

  it("posts once and shows the folder it just created", async () => {
    render(
      <TooltipProvider>
        <BookmarksPanel />
      </TooltipProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    postBookmarkFolderMock.mockResolvedValueOnce({ id: "f-1", name: "untitled" });
    getBookmarksMock.mockResolvedValue({
      folders: [{ id: "f-1", name: "untitled" }],
      bookmarks: [],
    });

    fireEvent.click(screen.getByLabelText("New bookmark folder"));

    // The panel must leave its empty state: before the fix the row was created
    // on the server and then hidden, which is what drove the second create.
    await waitFor(() => {
      expect(screen.getByTestId("bookmarks-panel")).toBeDefined();
    });

    // One user action, one POST — no double submit lurking behind the symptom.
    expect(postBookmarkFolderMock).toHaveBeenCalledTimes(1);
    // The row is present and hosting its inline input, seeded with the name
    // the server created — the folder is on screen, not swallowed.
    expect(
      document.querySelectorAll('[data-tree-row-kind="bookmark-folder"]').length,
    ).toBe(1);
    expect(screen.queryByTestId("bookmarks-empty-state")).toBeNull();
  });
});
