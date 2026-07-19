import { describe, it, expect, vi } from "vitest";
import {
  adaptBookmarks,
  buildBookmarkMenu,
  computeBookmarkMoveDispatch,
  findNoteTitle,
} from "./bookmarkTree.utils";
import type { Bookmark, BookmarkFolder } from "../lib/useTreeStore";
import type { TreeNode } from "../lib/treeApi";

describe("findNoteTitle", () => {
  const tree: TreeNode[] = [
    {
      kind: "folder",
      path: "a",
      name: "a",
      children: [
        {
          kind: "note",
          id: "n1",
          path: "a/n1.md",
          title: "First",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    },
    {
      kind: "note",
      id: "n2",
      path: "n2.md",
      title: "Second",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ];

  it("resolves a note nested inside a folder", () => {
    expect(findNoteTitle(tree, "n1")).toBe("First");
  });

  it("resolves a top-level note", () => {
    expect(findNoteTitle(tree, "n2")).toBe("Second");
  });

  it("returns null for an unknown id", () => {
    expect(findNoteTitle(tree, "missing")).toBeNull();
  });
});

describe("adaptBookmarks", () => {
  const resolveTitle = (noteId: string) => `Title-${noteId}`;
  const noteExists = () => true;

  it("builds top-level bookmark leaves, sorted by order", () => {
    const bookmarks: Bookmark[] = [
      { id: "bm-2", note_id: "note-b", folder_id: null, order: 1 },
      { id: "bm-1", note_id: "note-a", folder_id: null, order: 0 },
    ];
    const nodes = adaptBookmarks([], bookmarks, resolveTitle, noteExists);

    expect(nodes.map((n) => n.id)).toEqual(["bookmark:bm-1", "bookmark:bm-2"]);
    expect(nodes[0].data).toEqual({
      kind: "bookmark",
      bookmarkId: "bm-1",
      noteId: "note-a",
      title: "Title-note-a",
    });
  });

  it("nests bookmarks under their bookmark-folder, sorted by order, folders before top-level", () => {
    const folders: BookmarkFolder[] = [{ id: "f-1", name: "Work" }];
    const bookmarks: Bookmark[] = [
      { id: "bm-top", note_id: "note-top", folder_id: null, order: 0 },
      { id: "bm-2", note_id: "note-b", folder_id: "f-1", order: 1 },
      { id: "bm-1", note_id: "note-a", folder_id: "f-1", order: 0 },
    ];
    const nodes = adaptBookmarks(folders, bookmarks, resolveTitle, noteExists);

    expect(nodes[0].id).toBe("bmfolder:f-1");
    expect(nodes[0].data).toEqual({ kind: "bookmark-folder", folderId: "f-1", name: "Work" });
    expect(nodes[0].children?.map((c) => c.id)).toEqual(["bookmark:bm-1", "bookmark:bm-2"]);
    expect(nodes[1].id).toBe("bookmark:bm-top");
  });

  it("drops bookmarks whose note no longer resolves (D-04 prune)", () => {
    const bookmarks: Bookmark[] = [
      { id: "bm-live", note_id: "note-live", folder_id: null, order: 0 },
      { id: "bm-dead", note_id: "note-dead", folder_id: null, order: 1 },
    ];
    const exists = (noteId: string) => noteId === "note-live";
    const nodes = adaptBookmarks([], bookmarks, resolveTitle, exists);

    expect(nodes.map((n) => n.id)).toEqual(["bookmark:bm-live"]);
  });
});

describe("buildBookmarkMenu", () => {
  it("maps folders to id+name pairs and forwards handlers", () => {
    const onRemove = vi.fn();
    const onMoveToFolder = vi.fn();
    const onNewFolder = vi.fn();
    const folders: BookmarkFolder[] = [{ id: "f-1", name: "Work" }];

    const menu = buildBookmarkMenu(folders, { onRemove, onMoveToFolder, onNewFolder });

    expect(menu.folders).toEqual([{ id: "f-1", name: "Work" }]);
    menu.onRemove("note-a");
    expect(onRemove).toHaveBeenCalledWith("note-a");
    menu.onMoveToFolder("bm-1", "f-1");
    expect(onMoveToFolder).toHaveBeenCalledWith("bm-1", "f-1");
    menu.onNewFolder();
    expect(onNewFolder).toHaveBeenCalledTimes(1);
  });
});

describe("computeBookmarkMoveDispatch", () => {
  const topA: Bookmark = { id: "bm-a", note_id: "note-a", folder_id: null, order: 0 };
  const topB: Bookmark = { id: "bm-b", note_id: "note-b", folder_id: null, order: 1 };
  const topC: Bookmark = { id: "bm-c", note_id: "note-c", folder_id: null, order: 2 };
  const inFolder: Bookmark = { id: "bm-d", note_id: "note-d", folder_id: "f-1", order: 0 };

  it("returns noop when no bookmarks are dragged", () => {
    const result = computeBookmarkMoveDispatch([topA], [], null, 0);
    expect(result).toEqual({ action: "noop" });
  });

  it("dispatches moveToFolder when the destination folder differs from the source", () => {
    const result = computeBookmarkMoveDispatch([topA, inFolder], ["bm-a"], "f-1", 0);
    expect(result).toEqual({
      action: "moveToFolder",
      bookmarkIds: ["bm-a"],
      folderId: "f-1",
    });
  });

  it("dispatches moveToFolder when dragging OUT of a folder to top-level (destFolderId null)", () => {
    const result = computeBookmarkMoveDispatch([inFolder], ["bm-d"], null, 0);
    expect(result).toEqual({
      action: "moveToFolder",
      bookmarkIds: ["bm-d"],
      folderId: null,
    });
  });

  it("dispatches reorder with the new ordered id list when the destination folder is unchanged", () => {
    // A(0) B(1) C(2), dragging C to index 0 (before A).
    const result = computeBookmarkMoveDispatch([topA, topB, topC], ["bm-c"], null, 0);
    expect(result).toEqual({
      action: "reorder",
      folderId: null,
      orderedIds: ["bm-c", "bm-a", "bm-b"],
    });
  });

  it("reorder clamps an out-of-range index into the valid range", () => {
    const result = computeBookmarkMoveDispatch([topA, topB], ["bm-a"], null, 99);
    expect(result).toEqual({
      action: "reorder",
      folderId: null,
      orderedIds: ["bm-b", "bm-a"],
    });
  });
});
