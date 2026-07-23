/**
 * BookmarksPanel — onRootDrop wiring tests (quick task 260719-jv1 follow-up:
 * bookmark drag-to-root).
 *
 * TreeView's own empty-area root-drop mechanics (window-level native-drag
 * listeners, `[role="tree"]` scoping) are unit-tested in TreeView.test.tsx.
 * This file only proves BookmarksPanel wires `onRootDrop` correctly:
 * a folder-held bookmark dragged to root calls moveToFolder(id, null); a
 * bookmark already at root is skipped (no-op, no redundant API call).
 *
 * TreeView is mocked to a thin stub that captures the onRootDrop prop so
 * the callback can be invoked directly — the real drag *gesture* is
 * covered by TreeView.test.tsx + the orchestrator's real-mouse browser
 * pass, per the "verify DnD with real mouse" memory.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { NodeApi } from "react-arborist";

import { BookmarksPanel } from "./BookmarksPanel";
import { TooltipProvider } from "./Tooltip";
import { useTreeStore } from "../lib/useTreeStore";
import { usePaneStore } from "../lib/usePaneStore";
import type { Tree } from "../lib/treeApi";
import type { ArboristNode } from "./fileTree.utils";

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

vi.mock("../components/toast.utils", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const mockUseFileTree = vi.fn();
vi.mock("../lib/useFileTree", () => ({
  useFileTree: () => mockUseFileTree(),
}));

let capturedOnRootDrop:
  | ((dragNodes: NodeApi<ArboristNode>[]) => void)
  | undefined;

vi.mock("./TreeView", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TreeView: (props: any) => {
    capturedOnRootDrop = props.onRootDrop;
    return <div data-testid="tree-view-stub" />;
  },
}));

const mockTree: Tree = {
  root: [
    { kind: "note", id: "note-a", path: "a.md", title: "Alpha Note" },
    { kind: "note", id: "note-b", path: "b.md", title: "Beta Note" },
  ],
} as unknown as Tree;

const bookmarkAtRoot = {
  id: "bm-1",
  note_id: "note-a",
  folder_id: null,
  order: 0,
};
const bookmarkInFolder = {
  id: "bm-2",
  note_id: "note-b",
  folder_id: "f-1",
  order: 0,
};
const folder1 = { id: "f-1", name: "Work" };

async function renderPanel(ui: ReactElement) {
  const result = render(<TooltipProvider>{ui}</TooltipProvider>);
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

function fakeBookmarkDragNode(bookmarkId: string): NodeApi<ArboristNode> {
  return {
    data: {
      data: {
        kind: "bookmark",
        bookmarkId,
        noteId: "irrelevant",
        title: "irrelevant",
      },
    },
  } as unknown as NodeApi<ArboristNode>;
}

describe("BookmarksPanel onRootDrop wiring", () => {
  beforeEach(() => {
    capturedOnRootDrop = undefined;
    getBookmarksMock.mockReset().mockResolvedValue({ folders: [], bookmarks: [] });
    postBookmarkMock.mockReset();
    deleteBookmarkMock.mockReset();
    postBookmarkMoveMock.mockReset();
    postBookmarkFolderMock.mockReset();
    mockUseFileTree.mockReset().mockReturnValue({
      tree: mockTree,
      loading: false,
      error: null,
      refresh: vi.fn(),
      mutate: vi.fn(),
    });
    useTreeStore.setState({ bookmarks: [], bookmarkFolders: [], activeNoteId: null });
    usePaneStore.setState({ openInActivePane: vi.fn() });
  });

  it("passes onRootDrop to TreeView", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [folder1],
      bookmarks: [bookmarkInFolder],
    });
    await renderPanel(<BookmarksPanel />);
    expect(typeof capturedOnRootDrop).toBe("function");
  });

  it("moves a folder-held bookmark to root (moveToFolder(id, null)) when onRootDrop fires", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [folder1],
      bookmarks: [bookmarkInFolder],
    });
    await renderPanel(<BookmarksPanel />);

    postBookmarkMoveMock.mockResolvedValueOnce({ id: "bm-2", folder_id: null });
    act(() => {
      capturedOnRootDrop!([fakeBookmarkDragNode("bm-2")]);
    });

    await waitFor(() => {
      expect(postBookmarkMoveMock).toHaveBeenCalledWith("bm-2", null);
    });
  });

  it("no-ops (does not call moveToFolder) for a bookmark already at top level", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [],
      bookmarks: [bookmarkAtRoot],
    });
    await renderPanel(<BookmarksPanel />);

    act(() => {
      capturedOnRootDrop!([fakeBookmarkDragNode("bm-1")]);
    });

    expect(postBookmarkMoveMock).not.toHaveBeenCalled();
  });

  it("handles a mixed multi-drag: moves the folder-held bookmark, skips the root one", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [folder1],
      bookmarks: [bookmarkAtRoot, bookmarkInFolder],
    });
    await renderPanel(<BookmarksPanel />);

    postBookmarkMoveMock.mockResolvedValueOnce({ id: "bm-2", folder_id: null });
    act(() => {
      capturedOnRootDrop!([
        fakeBookmarkDragNode("bm-1"),
        fakeBookmarkDragNode("bm-2"),
      ]);
    });

    await waitFor(() => {
      expect(postBookmarkMoveMock).toHaveBeenCalledWith("bm-2", null);
    });
    expect(postBookmarkMoveMock).toHaveBeenCalledTimes(1);
  });
});
