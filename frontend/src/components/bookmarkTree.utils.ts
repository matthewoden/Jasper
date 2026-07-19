/**
 * bookmarkTree.utils — pure helpers turning a bookmarks document into the
 * SAME ArboristNode shape FileTree feeds into TreeView (quick task
 * 260719-jv1, item 5). Mirrors fileTree.utils.ts's adaptTree/adaptToArborist
 * role for the Notes tree.
 *
 * Two-level shape (bookmarks have no nesting, D-04/BOOK-03): each
 * BookmarkFolder becomes a `bookmark-folder` ArboristNode containing its
 * member bookmarks (sorted by `order`) as `bookmark` leaf children;
 * top-level (folder_id === null) bookmarks are leaves at the root.
 */
import type { ArboristNode } from "./fileTree.utils";
import type { BookmarkMenuDescriptor } from "./TreeRow";
import type { Bookmark, BookmarkFolder } from "../lib/useTreeStore";
import type { TreeNode as WireTreeNode } from "../lib/treeApi";

/**
 * Live note title by UUID — walks the Notes wire tree (D-02 noteId
 * identity: a bookmark only ever stores note_id, never a cached title).
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
 * title (D-02); noteExists gates the D-04 absent-note prune (a bookmark
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
