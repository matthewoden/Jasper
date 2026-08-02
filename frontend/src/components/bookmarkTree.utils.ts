/**
 * bookmarkTree.utils — pure helpers turning a bookmarks document into the
 * SAME ArboristNode shape FileTree feeds into TreeView (quick task
 * 260719-jv1, item 5). Mirrors fileTree.utils.ts's adaptTree/adaptToArborist
 * role for the Notes tree.
 *
 * Two-level shape (bookmarks have no nesting, BOOK-03): each
 * BookmarkFolder becomes a `bookmark-folder` ArboristNode containing its
 * member bookmarks (sorted by `order`) as `bookmark` leaf children;
 * top-level (folder_id === null) bookmarks are leaves at the root.
 */
import type { ArboristNode } from "./fileTree.utils";
import type { BookmarkMenuDescriptor } from "./TreeRow";
import type { Bookmark, BookmarkFolder } from "../lib/useTreeStore";
import type { TreeNode as WireTreeNode } from "../lib/treeApi";

/**
 * Live note title by UUID — walks the Notes wire tree (a bookmark only
 * ever stores note_id, never a cached title).
 * Verbatim port of BookmarksPanel's pre-existing private findNoteTitle,
 * relocated here so both the panel and the adapter can share it.
 */
export function findNoteTitle(
  nodes: ReadonlyArray<WireTreeNode>,
  id: string,
): string | null {
  for (const node of nodes) {
    if (node.kind === "note" && node.id === id) return node.title;
    if (node.kind === "folder" && Array.isArray(node.children)) {
      const found = findNoteTitle(node.children, id);
      if (found !== null) return found;
    }
  }
  return null;
}

function bookmarkNode(
  bookmark: Bookmark,
  resolveTitle: (noteId: string) => string,
): ArboristNode {
  const title = resolveTitle(bookmark.note_id);
  return {
    id: "bookmark:" + bookmark.id,
    name: title,
    data: {
      kind: "bookmark",
      bookmarkId: bookmark.id,
      noteId: bookmark.note_id,
      title,
    },
  };
}

function byOrder(a: Bookmark, b: Bookmark): number {
  return a.order - b.order;
}

/**
 * Bookmark -> ArboristNode adapter. resolveTitle resolves a note's live
 * title; noteExists gates the absent-note prune (a bookmark
 * whose note no longer resolves is dropped from the visible tree — same
 * defense-in-depth as the pre-existing bespoke BookmarksPanel).
 */
export function adaptBookmarks(
  folders: readonly BookmarkFolder[],
  bookmarks: readonly Bookmark[],
  resolveTitle: (noteId: string) => string,
  noteExists: (noteId: string) => boolean,
): ArboristNode[] {
  const visible = bookmarks.filter((b) => noteExists(b.note_id));

  const folderNodes: ArboristNode[] = folders.map((folder) => ({
    id: "bmfolder:" + folder.id,
    name: folder.name,
    data: { kind: "bookmark-folder", folderId: folder.id, name: folder.name },
    children: visible
      .filter((b) => b.folder_id === folder.id)
      .slice()
      .sort(byOrder)
      .map((b) => bookmarkNode(b, resolveTitle)),
  }));

  const topLevel = visible
    .filter((b) => b.folder_id === null)
    .slice()
    .sort(byOrder)
    .map((b) => bookmarkNode(b, resolveTitle));

  return [...folderNodes, ...topLevel];
}

/**
 * Builds the BookmarkMenuDescriptor TreeRow needs to render the
 * Remove / Move-to-folder / New-folder kebab menu for `kind: "bookmark"`
 * rows — keeps the folder-list-shaping (id+name only) out of
 * BookmarksPanel.tsx itself.
 */
export function buildBookmarkMenu(
  folders: readonly BookmarkFolder[],
  handlers: {
    onRemove: (noteId: string) => void;
    onMoveToFolder: (bookmarkId: string, folderId: string | null) => void;
    onNewFolder: () => void;
  },
): BookmarkMenuDescriptor {
  return {
    folders: folders.map((f) => ({ id: f.id, name: f.name })),
    onRemove: handlers.onRemove,
    onMoveToFolder: handlers.onMoveToFolder,
    onNewFolder: handlers.onNewFolder,
  };
}

/** Discriminated dispatch decision for a bookmark drag-drop, computed by
 *  computeBookmarkMoveDispatch — mirrors fileTree.utils.ts's
 *  computeMoveTarget role (a pure, directly-testable core so the real drag
 *  gesture itself only needs proving once, in a real browser — Task 7 /
 *  the "verify DnD with real mouse" memory). */
export type BookmarkMoveDispatch =
  | { action: "noop" }
  | { action: "moveToFolder"; bookmarkIds: string[]; folderId: string | null }
  | {
      action: "reorder";
      folderId: string | null;
      orderedIds: string[];
    };

/**
 * Decides what a bookmark drag-drop means: cross-folder file (destination
 * folder differs from the dragged bookmarks' current folder_id) vs a
 * within-folder reorder (destination folder is unchanged — compute the new
 * full ordered id list for that scope from the drop `index`).
 *
 * Multi-drag is assumed to share one source scope — react-arborist only
 * groups same-parent rows into a single drag gesture, matching the
 * pre-existing bespoke panel (which never supported cross-folder
 * multi-select drag either).
 */
export function computeBookmarkMoveDispatch(
  bookmarks: readonly Bookmark[],
  draggedBookmarkIds: readonly string[],
  destFolderId: string | null,
  index: number,
): BookmarkMoveDispatch {
  if (draggedBookmarkIds.length === 0) {
    return { action: "noop" };
  }

  const sourceFolderId =
    bookmarks.find((b) => b.id === draggedBookmarkIds[0])?.folder_id ?? null;

  if (sourceFolderId !== destFolderId) {
    return {
      action: "moveToFolder",
      bookmarkIds: [...draggedBookmarkIds],
      folderId: destFolderId,
    };
  }

  const remainingScopeIds = bookmarks
    .filter((b) => b.folder_id === destFolderId)
    .filter((b) => !draggedBookmarkIds.includes(b.id))
    .slice()
    .sort(byOrder)
    .map((b) => b.id);

  const insertAt = Math.min(Math.max(index, 0), remainingScopeIds.length);
  const orderedIds = [
    ...remainingScopeIds.slice(0, insertAt),
    ...draggedBookmarkIds,
    ...remainingScopeIds.slice(insertAt),
  ];

  return { action: "reorder", folderId: destFolderId, orderedIds };
}
