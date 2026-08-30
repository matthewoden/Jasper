import { describe, it, expect } from "vitest";
import {
  adaptBookmarks,
  buildNoteMetaMap,
  computeBookmarkMoveDispatch,
  findNoteTitle,
} from "./bookmarkTree.utils";
import type { BookmarkNoteMeta } from "./bookmarkTree.utils";
import type {
  Bookmark,
  BookmarkFolder,
  BookmarksSortOrder,
} from "../lib/useTreeStore";
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

  it("drops bookmarks whose note no longer resolves (prune)", () => {
    const bookmarks: Bookmark[] = [
      { id: "bm-live", note_id: "note-live", folder_id: null, order: 0 },
      { id: "bm-dead", note_id: "note-dead", folder_id: null, order: 1 },
    ];
    const exists = (noteId: string) => noteId === "note-live";
    const nodes = adaptBookmarks([], bookmarks, resolveTitle, exists);

    expect(nodes.map((n) => n.id)).toEqual(["bookmark:bm-live"]);
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

describe("buildNoteMetaMap", () => {
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
          updated_at: "2026-01-02T00:00:00Z",
          created: "2026-01-01T00:00:00Z",
        },
      ],
    },
    {
      kind: "note",
      id: "n2",
      path: "n2.md",
      title: "Second",
      updated_at: "2026-01-03T00:00:00Z",
    },
  ] as unknown as TreeNode[];

  it("indexes every note by id, nested included", () => {
    const map = buildNoteMetaMap(tree);
    expect(map.get("n1")).toEqual({
      title: "First",
      updated_at: "2026-01-02T00:00:00Z",
      created: "2026-01-01T00:00:00Z",
    });
    expect(map.get("n2")?.title).toBe("Second");
    expect(map.has("missing")).toBe(false);
  });
});

describe("adaptBookmarks — sort orders", () => {
  const noteExists = () => true;

  // order fields deliberately run counter to every derived order so a
  // passing assertion can only come from the requested comparator.
  const bookmarks: Bookmark[] = [
    { id: "bm-c", note_id: "note-c", folder_id: null, order: 0 },
    { id: "bm-a", note_id: "note-a", folder_id: null, order: 1 },
    { id: "bm-b", note_id: "note-b", folder_id: null, order: 2 },
  ];

  const meta: Record<string, BookmarkNoteMeta> = {
    "note-a": {
      title: "Apple",
      updated_at: "2026-01-01T00:00:00Z",
      created: "2026-03-01T00:00:00Z",
    },
    "note-b": {
      title: "Banana",
      updated_at: "2026-01-03T00:00:00Z",
      created: "2026-03-02T00:00:00Z",
    },
    "note-c": {
      title: "Cherry",
      updated_at: "2026-01-02T00:00:00Z",
      created: "2026-03-03T00:00:00Z",
    },
  };

  const resolveTitle = (noteId: string) => meta[noteId].title;
  const resolveMeta = (noteId: string) => meta[noteId];

  function idsFor(order: BookmarksSortOrder): string[] {
    return adaptBookmarks([], bookmarks, resolveTitle, noteExists, {
      order,
      resolveMeta,
    }).map((n) => n.id);
  }

  it("manual keeps the persisted Order field", () => {
    expect(idsFor("manual")).toEqual([
      "bookmark:bm-c",
      "bookmark:bm-a",
      "bookmark:bm-b",
    ]);
  });

  it("defaults to manual when no order is supplied", () => {
    const nodes = adaptBookmarks([], bookmarks, resolveTitle, noteExists);
    expect(nodes.map((n) => n.id)).toEqual([
      "bookmark:bm-c",
      "bookmark:bm-a",
      "bookmark:bm-b",
    ]);
  });

  it("sorts by target-note title", () => {
    expect(idsFor("name-asc")).toEqual([
      "bookmark:bm-a",
      "bookmark:bm-b",
      "bookmark:bm-c",
    ]);
    expect(idsFor("name-desc")).toEqual([
      "bookmark:bm-c",
      "bookmark:bm-b",
      "bookmark:bm-a",
    ]);
  });

  it("sorts by target-note updated_at", () => {
    expect(idsFor("modified-asc")).toEqual([
      "bookmark:bm-a",
      "bookmark:bm-c",
      "bookmark:bm-b",
    ]);
    expect(idsFor("modified-desc")).toEqual([
      "bookmark:bm-b",
      "bookmark:bm-c",
      "bookmark:bm-a",
    ]);
  });

  it("sorts by target-note created", () => {
    expect(idsFor("created-asc")).toEqual([
      "bookmark:bm-a",
      "bookmark:bm-b",
      "bookmark:bm-c",
    ]);
    expect(idsFor("created-desc")).toEqual([
      "bookmark:bm-c",
      "bookmark:bm-b",
      "bookmark:bm-a",
    ]);
  });

  it("tie-breaks on title when the timestamp is missing on both sides", () => {
    const bare: Bookmark[] = [
      { id: "bm-b", note_id: "note-b", folder_id: null, order: 0 },
      { id: "bm-a", note_id: "note-a", folder_id: null, order: 1 },
    ];
    const nodes = adaptBookmarks([], bare, resolveTitle, noteExists, {
      order: "created-desc",
      resolveMeta: () => undefined,
    });
    expect(nodes.map((n) => n.id)).toEqual(["bookmark:bm-a", "bookmark:bm-b"]);
  });

  it("applies the same order inside a folder's children", () => {
    const folders: BookmarkFolder[] = [{ id: "f-1", name: "Work" }];
    const filed: Bookmark[] = bookmarks.map((b) => ({ ...b, folder_id: "f-1" }));
    const nodes = adaptBookmarks(folders, filed, resolveTitle, noteExists, {
      order: "name-asc",
      resolveMeta,
    });
    expect(nodes[0].children?.map((n) => n.id)).toEqual([
      "bookmark:bm-a",
      "bookmark:bm-b",
      "bookmark:bm-c",
    ]);
  });
});
