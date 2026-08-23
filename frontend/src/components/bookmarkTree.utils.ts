/**
 * bookmarkTree.utils — pure helpers turning a bookmarks document into the
 * SAME ArboristNode shape FileTree feeds into TreeView. Mirrors
 * fileTree.utils.ts's adaptTree/adaptToArborist role for the Notes tree.
 *
 * Two-level shape (bookmarks have no nesting, BOOK-03): each
 * BookmarkFolder becomes a `bookmark-folder` ArboristNode containing its
 * member bookmarks as `bookmark` leaf children; top-level
 * (folder_id === null) bookmarks are leaves at the root. Member order comes
 * from the active BookmarksSortOrder — the drag-assigned `order` field under
 * "manual", the target note's own metadata otherwise.
 */
import type { ArboristNode } from "./fileTree.utils";
import type { BookmarkMenuDescriptor } from "./TreeRow";
import type {
  Bookmark,
  BookmarkFolder,
  BookmarksSortOrder,
} from "../lib/useTreeStore";
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

/** The bookmarked note's own metadata — what every non-manual order sorts on. */
export interface BookmarkNoteMeta {
  title: string;
  updated_at?: string;
  created?: string;
}

/**
 * Indexes the Notes wire tree by note id in ONE walk. The bookmarks list
 * carries no note metadata, and the panel already holds the tree for title
 * resolution, so the sort joins against this map rather than fetching
 * per-bookmark.
 */
export function buildNoteMetaMap(
  nodes: ReadonlyArray<WireTreeNode>,
): Map<string, BookmarkNoteMeta> {
  const map = new Map<string, BookmarkNoteMeta>();
  const visit = (node: WireTreeNode) => {
    if (node.kind === "note") {
      map.set(node.id, {
        title: node.title,
        updated_at: node.updated_at,
        created: node.created,
      });
    } else if (node.kind === "folder" && Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };
  for (const node of nodes) visit(node);
  return map;
}

function timestampOf(
  meta: BookmarkNoteMeta | undefined,
  field: "updated_at" | "created",
): number {
  const value = meta?.[field];
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Comparator for one bookmark scope. Manual reads the drag-assigned
 * `order`; every other branch reads the target note's metadata and
 * tie-breaks on title so an absent timestamp still orders deterministically
 * (mirrors fileTree.utils.comparatorFor).
 */
export function bookmarkComparator(
  order: BookmarksSortOrder,
  resolveTitle: (noteId: string) => string,
  resolveMeta: (noteId: string) => BookmarkNoteMeta | undefined,
): (a: Bookmark, b: Bookmark) => number {
  const byTitle = (a: Bookmark, b: Bookmark) =>
    resolveTitle(a.note_id).localeCompare(resolveTitle(b.note_id));
  const byTime = (field: "updated_at" | "created", desc: boolean) =>
    (a: Bookmark, b: Bookmark) => {
      const ta = timestampOf(resolveMeta(a.note_id), field);
      const tb = timestampOf(resolveMeta(b.note_id), field);
      return (desc ? tb - ta : ta - tb) || byTitle(a, b);
    };

  switch (order) {
    case "name-asc":
      return byTitle;
    case "name-desc":
      return (a, b) => byTitle(b, a);
    case "modified-desc":
      return byTime("updated_at", true);
    case "modified-asc":
      return byTime("updated_at", false);
    case "created-desc":
      return byTime("created", true);
    case "created-asc":
      return byTime("created", false);
    default:
      return byOrder;
  }
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
  options?: {
    order?: BookmarksSortOrder;
    resolveMeta?: (noteId: string) => BookmarkNoteMeta | undefined;
  },
): ArboristNode[] {
  const visible = bookmarks.filter((b) => noteExists(b.note_id));
  const compare = bookmarkComparator(
    options?.order ?? "manual",
    resolveTitle,
    options?.resolveMeta ?? (() => undefined),
  );

  const folderNodes: ArboristNode[] = folders.map((folder) => ({
    id: "bmfolder:" + folder.id,
    name: folder.name,
    data: { kind: "bookmark-folder", folderId: folder.id, name: folder.name },
    children: visible
      .filter((b) => b.folder_id === folder.id)
      .slice()
      .sort(compare)
      .map((b) => bookmarkNode(b, resolveTitle)),
  }));

  const topLevel = visible
    .filter((b) => b.folder_id === null)
    .slice()
    .sort(compare)
    .map((b) => bookmarkNode(b, resolveTitle));

  return [...folderNodes, ...topLevel];
}

/**
 * Builds the BookmarkMenuDescriptor TreeRow needs to render the
 * ORPHANED 2026-08-22: BookmarksPanel now routes through TreeRow's
 * rowMenuOverride; the only remaining callers are this file's own tests.
 * Kept pending JASPER-37.
 *
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
 *  gesture itself only needs proving once, in a real browser). */
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
