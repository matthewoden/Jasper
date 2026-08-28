/**
 * Panel-level wiring for the two row menus: which mutation each item reaches,
 * and that deleting a folder keeps the bookmarks that were inside it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

import { BookmarksPanel } from "./BookmarksPanel";
import { TooltipProvider } from "./Tooltip";
import {
  bookmarksResource,
  BookmarkFolderNameConflictError,
} from "../lib/bookmarksApi";
import type { Tree } from "../lib/treeApi";

const getBookmarksMock = vi.fn();
const deleteBookmarkMock = vi.fn();
const postBookmarkMoveMock = vi.fn();
const postBookmarkFolderMock = vi.fn();
const putBookmarkFolderMock = vi.fn();
const deleteBookmarkFolderMock = vi.fn();

vi.mock("../lib/bookmarksApi", async () => {
  const { createResource } = await import("../lib/resources/createResource");
  class BookmarkFolderNameConflictError extends Error {}
  return {
    BookmarkFolderNameConflictError,
    bookmarksResource: createResource("bookmarks", () => getBookmarksMock(), {
      mode: "cached",
      invalidatedBy: ["bookmark:changed"],
    }),
    postBookmark: vi.fn(),
    deleteBookmark: (...args: unknown[]) => deleteBookmarkMock(...args),
    postBookmarkMove: (...args: unknown[]) => postBookmarkMoveMock(...args),
    postBookmarkFolder: (...args: unknown[]) => postBookmarkFolderMock(...args),
    putBookmarkFolder: (...args: unknown[]) => putBookmarkFolderMock(...args),
    deleteBookmarkFolder: (...args: unknown[]) =>
      deleteBookmarkFolderMock(...args),
    reorderBookmarks: vi.fn(),
  };
});

vi.mock("../components/toast.utils", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const deleteNoteMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/useTreeMutations", () => ({
  // RenameInput narrows on TreeMutationError, so the mock has to carry it or
  // the instanceof throws before any error can reach the field.
  TreeMutationError: class TreeMutationError extends Error {},
  useTreeMutations: () => ({
    deleteNote: deleteNoteMock,
    deleteFolder: vi.fn(),
    moveNote: vi.fn(),
  }),
}));

vi.mock("../lib/useReveal", () => ({
  useReveal: () => ({ reveal: vi.fn(), loading: false }),
}));

vi.mock("../lib/useMcpGrants", () => ({
  useMcpGrants: () => ({
    directLevelFor: () => null,
    levelFor: () => null,
    grant: vi.fn(),
    revoke: vi.fn(),
    inheritedGrantOn: () => null,
  }),
}));

const mockTree: Tree = {
  root: [
    { kind: "note", id: "note-a", path: "a.md", title: "Alpha Note" },
    { kind: "note", id: "note-b", path: "sub/b.md", title: "Beta Note" },
  ],
} as unknown as Tree;

vi.mock("../lib/useFileTree", () => ({
  useFileTree: () => ({
    tree: mockTree,
    loading: false,
    error: null,
    refresh: vi.fn(),
    mutate: vi.fn(),
  }),
  walkTreeCollect: () => ({ folders: new Set<string>(), notes: new Set<string>() }),
}));

const bookmarkInFolder = {
  id: "bm-2",
  note_id: "note-b",
  folder_id: "f-1",
  order: 0,
};
const topLevelBookmark = {
  id: "bm-1",
  note_id: "note-a",
  folder_id: null,
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

function rowFor(kind: string, id: string): HTMLElement {
  return document.querySelector(
    `[data-tree-row-kind="${kind}"][data-tree-row="${id}"]`,
  ) as HTMLElement;
}

function openMenu(row: HTMLElement, label: string) {
  const trigger = row.querySelector(
    `button[aria-label='${label}']`,
  ) as HTMLElement;
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  return trigger;
}

describe("BookmarksPanel row menus", () => {
  beforeEach(async () => {
    getBookmarksMock.mockReset().mockResolvedValue({ folders: [], bookmarks: [] });
    deleteBookmarkMock.mockReset();
    postBookmarkMoveMock.mockReset();
    postBookmarkFolderMock.mockReset();
    putBookmarkFolderMock.mockReset();
    deleteBookmarkFolderMock.mockReset();
    deleteNoteMock.mockReset();
    bookmarksResource.clear();
  });

  it("gives bookmark rows the full options menu", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [],
      bookmarks: [topLevelBookmark],
    });
    await renderPanel(<BookmarksPanel />);

    openMenu(rowFor("bookmark", "bm-1"), "Bookmark options");
    for (const label of [
      "Rename",
      "Move to…",
      "Remove bookmark",
      "Move to bookmark folder",
      "Split right",
      "Split down",
      "Find",
      "Replace",
      "Reveal in navigation",
      "Show in file manager",
      "Delete",
    ]) {
      expect(await screen.findByRole("menuitem", { name: label })).toBeTruthy();
    }
  });

  it("removes the bookmark from the row menu", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [],
      bookmarks: [topLevelBookmark],
    });
    await renderPanel(<BookmarksPanel />);

    openMenu(rowFor("bookmark", "bm-1"), "Bookmark options");
    deleteBookmarkMock.mockResolvedValueOnce(undefined);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove bookmark" }));

    await waitFor(() => {
      expect(deleteBookmarkMock).toHaveBeenCalledWith("bm-1");
    });
  });

  it("files the bookmark into a folder from the move submenu", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [folder1],
      bookmarks: [topLevelBookmark],
    });
    await renderPanel(<BookmarksPanel />);

    openMenu(rowFor("bookmark", "bm-1"), "Bookmark options");
    const subTrigger = await screen.findByRole("menuitem", {
      name: "Move to bookmark folder",
    });
    fireEvent.pointerDown(subTrigger, { button: 0 });
    fireEvent.click(subTrigger);

    postBookmarkMoveMock.mockResolvedValueOnce({ id: "bm-1", folder_id: "f-1" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Work" }));

    await waitFor(() => {
      expect(postBookmarkMoveMock).toHaveBeenCalledWith("bm-1", "f-1");
    });
  });

  it("renames a bookmark folder inline", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [folder1],
      bookmarks: [bookmarkInFolder],
    });
    await renderPanel(<BookmarksPanel />);

    openMenu(rowFor("bookmark-folder", "f-1"), "Bookmark folder options");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename folder" }));

    const input = (await screen.findByLabelText(
      "Bookmark folder name",
    )) as HTMLInputElement;
    expect(input.value).toBe("Work");

    putBookmarkFolderMock.mockResolvedValueOnce({ id: "f-1", name: "Personal" });
    fireEvent.change(input, { target: { value: "Personal" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(putBookmarkFolderMock).toHaveBeenCalledWith("f-1", "Personal");
    });
  });

  // JASPER-24, locked: a refused name shows inline, and the field stays open
  // holding what was typed. Client-side first — the sibling list is right
  // there — with the server's 409 as the backstop for anything it missed.
  it("refuses a duplicate folder name inline without calling the server", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [folder1, { id: "f-2", name: "Personal" }],
      bookmarks: [bookmarkInFolder],
    });
    await renderPanel(<BookmarksPanel />);

    openMenu(rowFor("bookmark-folder", "f-1"), "Bookmark folder options");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename folder" }));
    const input = (await screen.findByLabelText(
      "Bookmark folder name",
    )) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "personal" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(input.value).toBe("personal");
    expect(document.contains(input)).toBe(true);
    expect(putBookmarkFolderMock).not.toHaveBeenCalled();
  });

  it("surfaces a server 409 inline and keeps the typed text", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [folder1],
      bookmarks: [bookmarkInFolder],
    });
    await renderPanel(<BookmarksPanel />);

    openMenu(rowFor("bookmark-folder", "f-1"), "Bookmark folder options");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename folder" }));
    const input = (await screen.findByLabelText(
      "Bookmark folder name",
    )) as HTMLInputElement;

    // Nothing local to catch this — the clash arrived after the panel loaded.
    putBookmarkFolderMock.mockRejectedValueOnce(
      new BookmarkFolderNameConflictError(
        "a folder with this name already exists",
      ),
    );
    fireEvent.change(input, { target: { value: "Archive" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "a folder with this name already exists",
      );
    });
    expect(input.value).toBe("Archive");
    expect(document.contains(input)).toBe(true);
  });

  it("deletes a bookmark folder but keeps the bookmarks that were inside it", async () => {
    getBookmarksMock.mockResolvedValue({
      folders: [folder1],
      bookmarks: [bookmarkInFolder],
    });
    await renderPanel(<BookmarksPanel />);

    openMenu(rowFor("bookmark-folder", "f-1"), "Bookmark folder options");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete folder" }));

    // The confirm has to say the bookmarks survive — the shared dialog's
    // "everything inside will be moved to Trash" copy would be a lie here.
    expect(await screen.findByText(/move to the top level/i)).toBeTruthy();

    deleteBookmarkFolderMock.mockResolvedValueOnce(undefined);
    getBookmarksMock.mockResolvedValue({
      folders: [],
      bookmarks: [{ ...bookmarkInFolder, folder_id: null }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));

    await waitFor(() => {
      expect(deleteBookmarkFolderMock).toHaveBeenCalledWith("f-1");
    });
    await waitFor(() => {
      expect(rowFor("bookmark", "bm-2")).not.toBeNull();
    });
    await waitFor(() => {
      expect(rowFor("bookmark-folder", "f-1")).toBeNull();
    });
  });
});
