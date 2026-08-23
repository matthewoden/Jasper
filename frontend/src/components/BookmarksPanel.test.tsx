/**
 * BookmarksPanel tests.
 *
 * Covers the empty state, live-titled rows, open-in-active-pane, folder
 * collapse, the "…" menu's Remove/Move-to-folder, and inline
 * "New bookmark folder" input, Sidebar wiring assertions live in Sidebar.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

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
const putBookmarkFolderMock = vi.fn();
const deleteBookmarkFolderMock = vi.fn();
const reorderBookmarksMock = vi.fn();

vi.mock("../lib/bookmarksApi", async () => {
  const { createResource } = await import("../lib/resources/createResource");
  return {
    bookmarksResource: createResource(
      "bookmarks",
      () => getBookmarksMock(),
      { mode: "cached", invalidatedBy: ["bookmark:changed"] },
    ),
    postBookmark: (...args: unknown[]) => postBookmarkMock(...args),
    deleteBookmark: (...args: unknown[]) => deleteBookmarkMock(...args),
    postBookmarkMove: (...args: unknown[]) => postBookmarkMoveMock(...args),
    postBookmarkFolder: (...args: unknown[]) =>
      postBookmarkFolderMock(...args),
    putBookmarkFolder: (...args: unknown[]) => putBookmarkFolderMock(...args),
    deleteBookmarkFolder: (...args: unknown[]) =>
      deleteBookmarkFolderMock(...args),
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
  const result = render(<TooltipProvider>{ui}</TooltipProvider>);
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

/**
 * BookmarksPanel now renders bookmark rows through the shared TreeRow
 * — there's no `data-testid="bookmark-row-*"`
 * anymore. TreeRow exposes `data-tree-row` (bookmarkId/folderId) +
 * `data-tree-row-kind` ("bookmark"/"bookmark-folder") instead; these
 * helpers query by those attributes so the DOM-structure change doesn't
 * force every test to hand-roll a selector.
 */
function bookmarkRow(bookmarkId: string): HTMLElement {
  return document.querySelector(
    `[data-tree-row-kind="bookmark"][data-tree-row="${bookmarkId}"]`,
  ) as HTMLElement;
}
function bookmarkFolderRow(folderId: string): HTMLElement {
  return document.querySelector(
    `[data-tree-row-kind="bookmark-folder"][data-tree-row="${folderId}"]`,
  ) as HTMLElement;
}

describe("BookmarksPanel", () => {
  beforeEach(() => {
    getBookmarksMock.mockReset().mockResolvedValue({ folders: [], bookmarks: [] });
    postBookmarkMock.mockReset();
    deleteBookmarkMock.mockReset();
    postBookmarkMoveMock.mockReset();
    postBookmarkFolderMock.mockReset();
    putBookmarkFolderMock.mockReset();
    deleteBookmarkFolderMock.mockReset();
    reorderBookmarksMock.mockReset();
    toastSpy.mockReset();
    // Per-entry reset (not the global registry reset): the eventBus
    // subscription createResource() wires up at module-load time inside
    // the mock factory above must survive across tests. clear() resets
    // cached data/hydrated/error without touching that subscription.
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

  it("(a) renders BookmarksEmptyState when the slice is empty", async () => {
    await renderPanel(<BookmarksPanel />);
    expect(screen.getByTestId("bookmarks-empty-state")).toBeDefined();
  });

  it("renders BookmarksErrorState (not the empty state) when the initial fetch fails, and Try again retries", async () => {
    getBookmarksMock.mockReset().mockRejectedValue(new Error("backend unreachable"));
    await renderPanel(<BookmarksPanel />);

    expect(screen.getByTestId("bookmarks-error-state")).toBeDefined();
    expect(screen.queryByTestId("bookmarks-empty-state")).toBeNull();

    getBookmarksMock.mockResolvedValueOnce({ folders: [], bookmarks: [bookmarkA] });
    fireEvent.click(screen.getByText("Try again"));

    await waitFor(() => {
      expect(screen.getByText("Alpha Note")).toBeDefined();
    });
    expect(screen.queryByTestId("bookmarks-error-state")).toBeNull();
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
    expect(bookmarkRow("bm-3")).toBeNull();
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

    fireEvent.click(bookmarkFolderRow("f-1"));
    expect(screen.queryByText("Beta Note")).toBeNull();

    fireEvent.click(bookmarkFolderRow("f-1"));
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

  // --- "…" menu (Remove / Move to folder), inline new-folder input ---

  function openRowMenu(bookmarkId: string) {
    const trigger = bookmarkRow(bookmarkId).querySelector(
      "button[aria-label='Bookmark options']",
    ) as HTMLElement;
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    return trigger;
  }

  it('"…" menu renders Remove + Move to folder; Remove calls the bookmark-remove path', async () => {
    getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [bookmarkA] });
    await renderPanel(<BookmarksPanel />);

    openRowMenu("bm-1");
    const removeItem = await screen.findByText("Remove bookmark");
    expect(screen.getByText("Move to bookmark folder")).toBeDefined();

    deleteBookmarkMock.mockResolvedValueOnce(undefined);
    fireEvent.click(removeItem);

    await waitFor(() => {
      expect(deleteBookmarkMock).toHaveBeenCalledWith("bm-1");
    });
  });

  it('"Move to folder" submenu calls moveToFolder', async () => {
    getBookmarksMock.mockResolvedValue({ folders: [folder1], bookmarks: [bookmarkA] });
    await renderPanel(<BookmarksPanel />);

    openRowMenu("bm-1");
    const subTrigger = await screen.findByText("Move to bookmark folder");
    fireEvent.pointerDown(subTrigger, { button: 0 });
    fireEvent.click(subTrigger);

    const folderItem = await screen.findByRole("menuitem", { name: "Work" });
    postBookmarkMoveMock.mockResolvedValueOnce({ id: "bm-1", folder_id: "f-1" });
    fireEvent.click(folderItem);

    await waitFor(() => {
      expect(postBookmarkMoveMock).toHaveBeenCalledWith("bm-1", "f-1");
    });
  });

  it('typing a name + Enter in the inline "New bookmark folder" input calls createFolder(name)', async () => {
    getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [bookmarkA] });
    await renderPanel(<BookmarksPanel />);

    fireEvent.click(screen.getByLabelText("New bookmark folder"));
    const input = screen.getByLabelText("New bookmark folder name");
    fireEvent.change(input, { target: { value: "Work" } });

    postBookmarkFolderMock.mockResolvedValueOnce({ id: "f-1", name: "Work" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(postBookmarkFolderMock).toHaveBeenCalledWith("Work");
    });
  });

  it("Esc cancels the inline new-folder input without creating", async () => {
    getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [bookmarkA] });
    await renderPanel(<BookmarksPanel />);

    fireEvent.click(screen.getByLabelText("New bookmark folder"));
    const input = screen.getByLabelText("New bookmark folder name");
    fireEvent.change(input, { target: { value: "Work" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByTestId("new-bookmark-folder-input")).toBeNull();
    expect(postBookmarkFolderMock).not.toHaveBeenCalled();
  });

  // --- follow-up item 5: Notes-panel chrome parity ---

  describe("Notes-panel chrome parity (follow-up item 5)", () => {
    it("renders a bordered 40px toolbar row hosting the New-bookmark-folder action", async () => {
      getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [bookmarkA] });
      await renderPanel(<BookmarksPanel />);

      const button = screen.getByLabelText("New bookmark folder");
      const toolbarRow = button.parentElement as HTMLElement;
      expect(toolbarRow.style.height).toBe("40px");
      expect(toolbarRow.style.borderBottom).toBe("1px solid var(--color-border)");
    });

    it("renders the bordered toolbar row even in the empty state", async () => {
      await renderPanel(<BookmarksPanel />);
      expect(screen.getByTestId("bookmarks-empty-state")).toBeDefined();
      const button = screen.getByLabelText("New bookmark folder");
      const toolbarRow = button.parentElement as HTMLElement;
      expect(toolbarRow.style.height).toBe("40px");
    });

    it("folder rows are 32px tall, matching TreeRow's row height", async () => {
      getBookmarksMock.mockResolvedValue({ folders: [folder1], bookmarks: [bookmarkB] });
      await renderPanel(<BookmarksPanel />);
      const folderRow = bookmarkFolderRow("f-1");
      expect(folderRow.style.height).toBe("32px");
    });

    it("a bookmark whose note is the active note gets the accent highlight + left bar", async () => {
      getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [bookmarkA] });
      useTreeStore.setState({ activeNoteId: "note-a" });
      await renderPanel(<BookmarksPanel />);
      const row = bookmarkRow("bm-1");
      expect(row.getAttribute("data-active")).toBe("true");
      expect(row.style.background).toContain("var(--color-accent)");
    });

    it("a bookmark whose note is NOT the active note has no accent highlight", async () => {
      getBookmarksMock.mockResolvedValue({ folders: [], bookmarks: [bookmarkA] });
      useTreeStore.setState({ activeNoteId: "note-b" });
      await renderPanel(<BookmarksPanel />);
      const row = bookmarkRow("bm-1");
      expect(row.getAttribute("data-active")).toBeNull();
    });
  });
});
