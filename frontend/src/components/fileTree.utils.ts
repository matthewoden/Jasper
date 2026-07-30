/**
 * FileTree pure helpers. Extracted from FileTree.tsx so the component file
 * only exports React components, satisfying react-refresh/only-export-components
 * and restoring Fast Refresh. All functions are exercised by FileTree.test.tsx.
 */
import type React from "react";
import type { NodeApi, TreeApi } from "react-arborist";

import type {
  Tree as WireTree,
  TreeNode as WireTreeNode,
} from "../lib/treeApi";
import {
  useTreeStore,
  type NotesSortOrder,
  type SearchSortOrder,
} from "../lib/useTreeStore";
import type { TreeRowData } from "./TreeRow";

export type { NotesSortOrder, SearchSortOrder };

/**
 * The shape react-arborist actually walks: id is unique across
 * folders+notes via a "folder:" / "note:" prefix; name is the visible
 * label (used by arborist for keyboard search); data preserves the
 * original wire shape so TreeRow can branch on `kind` without
 * re-parsing; children is folder-only (notes are leaves).
 */
export interface ArboristNode {
  id: string;
  name: string;
  data: TreeRowData;
  children?: ArboristNode[];
}

/**
 * Build a path → noteId lookup map by walking the wire tree.
 * Used by adaptToArborist to resolve parentNoteId for attachment files.
 * Only note nodes are indexed — folder and file nodes are skipped.
 */
export function buildNotePathMap(
  nodes: readonly WireTreeNode[],
): Map<string, string> {
  const map = new Map<string, string>();
  const visit = (n: WireTreeNode) => {
    if (n.kind === "note") {
      map.set(n.path, n.id);
    } else if (n.kind === "folder" && n.children) {
      for (const child of n.children) visit(child);
    }
  };
  for (const n of nodes) visit(n);
  return map;
}

/**
 * Derive the parentNoteId for a file node at `filePath`.
 *
 * @deprecated TreeRow no longer reads FileNodeData.parentNoteId; the file-click
 * handler now calls useTreeStore.setActiveFilePath(data.path) instead. This
 * function is preserved to avoid a breaking export change.
 */
export function deriveParentNoteId(
  filePath: string,
  notePathMap: Map<string, string>,
): string | undefined {
  const idx = filePath.indexOf("/attachments/");
  if (idx < 0) return undefined;
  const ownerDir = filePath.slice(0, idx);

  const siblingNote = ownerDir + ".md";
  if (notePathMap.has(siblingNote)) {
    return notePathMap.get(siblingNote);
  }

  const prefix = ownerDir + "/";
  for (const [notePath, noteId] of notePathMap) {
    if (notePath.startsWith(prefix) && notePath.endsWith(".md")) {
      return noteId;
    }
  }

  return undefined;
}

export function adaptToArborist(
  node: WireTreeNode,
  notePathMap?: Map<string, string>,
): ArboristNode {
  if (node.kind === "folder") {
    return {
      id: "folder:" + node.path,
      name: node.name,
      data: { kind: "folder", path: node.path, name: node.name },
      children: (node.children ?? []).map((c) =>
        adaptToArborist(c, notePathMap),
      ),
    };
  }
  if (node.kind === "file") {
    const parentNoteId = notePathMap
      ? deriveParentNoteId(node.path, notePathMap)
      : undefined;
    return {
      id: "file:" + node.path,
      name: node.name,
      data: { kind: "file", path: node.path, name: node.name, parentNoteId },
    };
  }
  return {
    id: "note:" + node.id,
    name: node.title,
    data: {
      kind: "note",
      id: node.id,
      path: node.path,
      title: node.title,
      updated_at: node.updated_at,
      created: node.created,
    },
  };
}

export function adaptTree(wireTree: WireTree): ArboristNode[] {
  const notePathMap = buildNotePathMap(wireTree.root);
  return wireTree.root.map((n) => adaptToArborist(n, notePathMap));
}


export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function composeNewPath(parent: string, name: string): string {
  if (parent === "") return name;
  return `${parent}/${name}`;
}


export interface MoveTarget {
  newPath: string;
  isNoOp: boolean;
}

export function computeMoveTarget(args: {
  sourcePath: string;
  parentNode: NodeApi<ArboristNode> | null;
}): MoveTarget {
  const { sourcePath, parentNode } = args;
  let parentPath = "";
  if (parentNode != null) {
    const pData = parentNode.data.data;
    if (pData.kind === "folder") {
      parentPath = pData.path;
    } else {
      const grand = parentNode.parent;
      if (grand && grand.data.data.kind === "folder") {
        parentPath = grand.data.data.path;
      } else {
        parentPath = "";
      }
    }
  }
  const baseName = basename(sourcePath);
  const newPath = composeNewPath(parentPath, baseName);
  return { newPath, isNoOp: newPath === sourcePath };
}

/** Decide which DeleteConfirmDialog variant to open for a selection. */
export function buildMultiDeleteTarget(
  d: TreeRowData,
  selectedNodes: ReadonlyArray<NodeApi<ArboristNode>>,
): { kind: "multi"; count: number } | null {
  const isMulti =
    selectedNodes.length > 1 && selectedNodes.some((n) => n.data.data === d);
  if (isMulti) {
    return { kind: "multi", count: selectedNodes.length };
  }
  return null;
}

/** Execute a batch delete over a snapshot of arborist's selectedNodes. Sequential, graceful partial-completion. */
export async function executeBatchDelete(
  selectedSnapshot: ReadonlyArray<NodeApi<ArboristNode>>,
  muts: {
    deleteNote: (id: string) => Promise<unknown>;
    deleteFolder: (path: string, recursive: boolean) => Promise<unknown>;
  },
): Promise<{ succeeded: number; total: number }> {
  let succeeded = 0;
  const total = selectedSnapshot.length;
  for (const node of selectedSnapshot) {
    const data = node.data.data;
    try {
      if (data.kind === "note") {
        await muts.deleteNote(data.id);
      } else if (data.kind === "folder" || data.kind === "file") {
        await muts.deleteFolder(data.path, true);
      }
      // bookmark / bookmark-folder rows are never selectable in the Notes
      // tree's batch-delete flow (FileTree only ever adapts folder/note/
      // file wire data into ArboristNode).
      succeeded += 1;
    } catch (err) {
      console.warn(
        "executeBatchDelete: per-item delete failed; continuing",
        err,
      );
    }
  }
  return { succeeded, total };
}

/** Descendant-deselect cascade: when a folder is selected, deselect all its children. */
export function deselectDescendantsOfFolders(
  nodes: ReadonlyArray<NodeApi<ArboristNode>>,
  deselect: (id: string) => void,
): void {
  const selectedFolders = nodes.filter((n) => n.data.data.kind === "folder");
  if (selectedFolders.length === 0) return;
  const collectIds = (n: NodeApi<ArboristNode>): string[] => {
    const out: string[] = [];
    if (!n.children) return out;
    for (const child of n.children) {
      out.push(child.id);
      out.push(...collectIds(child));
    }
    return out;
  };
  for (const folder of selectedFolders) {
    for (const id of collectIds(folder)) {
      deselect(id);
    }
  }
}

/**
 * Walk the wire tree starting at the matching folder path; returns the
 * counts of immediate notes + immediate subfolders for the delete
 * dialog body.
 */
export function countDescendants(
  tree: WireTree | null,
  folderPath: string,
): { notes: number; folders: number } {
  let notes = 0;
  let folders = 0;
  const findFolder = (
    nodes: readonly WireTreeNode[],
  ): WireTreeNode | null => {
    for (const n of nodes) {
      if (n.kind === "folder" && n.path === folderPath) return n;
      if (n.kind === "folder" && n.children) {
        const found = findFolder(n.children);
        if (found) return found;
      }
    }
    return null;
  };
  if (!tree) return { notes, folders };
  const folder = findFolder(tree.root);
  if (!folder || folder.kind !== "folder" || !folder.children)
    return { notes, folders };
  for (const child of folder.children) {
    if (child.kind === "folder") folders++;
    else notes++;
  }
  return { notes, folders };
}

/** Cycle-prevention check for native-DnD: folder cannot drop onto itself or its descendants. */
export function isCycleDrop(
  dragNodes: NodeApi<ArboristNode>[],
  destFolderPath: string,
): boolean {
  for (const dn of dragNodes) {
    if (dn.data.data.kind !== "folder") continue;
    const src = dn.data.data.path;
    if (destFolderPath === src) return true;
    if (destFolderPath.startsWith(src + "/")) return true;
  }
  return false;
}

/** Invalidates react-arborist's react-window FixedSizeList row-offset cache after a tree mutation. */
export function resetTreeListLayout(
  ref: React.RefObject<TreeApi<ArboristNode> | null>,
): void {
  const tree = ref.current;
  if (!tree) return;
  const list = tree.list?.current;
  if (!list) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyList = list as any;
  if (typeof anyList.resetAfterIndex === "function") {
    anyList.resetAfterIndex(0);
    return;
  }
  if (typeof anyList.forceUpdate === "function") {
    anyList.forceUpdate();
    return;
  }
}


let currentTreeRef: TreeApi<ArboristNode> | null = null;

export function setCurrentTreeRef(
  ref: TreeApi<ArboristNode> | null,
): void {
  currentTreeRef = ref;
}

/**
 * Expand and scroll the file tree to `folderPath`. Called by
 * Breadcrumbs when the user clicks a folder segment.
 */
export function expandAndScrollToFolder(folderPath: string): void {
  if (!folderPath) return;
  const state = useTreeStore.getState();
  if (!state.expanded.has(folderPath)) {
    state.toggleExpanded(folderPath);
  }
  const id = "folder:" + folderPath;
  try {
    currentTreeRef?.open(id);
    currentTreeRef?.scrollTo(id, "auto");
  } catch {
    // FileTree may be unmounted or arborist API mismatch — persistence
    // step above is sufficient; ignore.
  }
  state.setNotesSidebarVisible(true);
}

/**
 * Ancestor folder paths of a note, outermost-first. Tolerates leading/
 * duplicate/trailing slashes; the final segment (filename) is always
 * dropped. A root-level note yields [].
 */
export function ancestorFolderPaths(notePath: string): string[] {
  const segments = notePath.split("/").filter((s) => s.length > 0);
  segments.pop();
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    out.push(segments.slice(0, i + 1).join("/"));
  }
  return out;
}

/**
 * Expand every ancestor folder of `notePath` — both the live tree (if
 * mounted) and the persisted store. Deliberately quieter than
 * expandAndScrollToFolder/revealInNavigation: no sidebar-visibility force,
 * no panel switch, no scroll, no pulse (D-3, pp9).
 */
export function expandNoteAncestorFolders(notePath: string): void {
  const state = useTreeStore.getState();
  for (const path of ancestorFolderPaths(notePath)) {
    try {
      currentTreeRef?.open("folder:" + path);
    } catch {
      // FileTree may be unmounted or arborist API mismatch — the store
      // write below still seeds initialOpenState on the next mount.
    }
    // open() synchronously fires onToggle, which mirrors arborist's
    // possibly-not-yet-flushed isOpen back into the store (F4) — so the
    // explicit `true` must land last to avoid being undone by that mirror.
    state.setFolderExpanded(path, true);
  }
}

/**
 * Scroll the file tree to a note's row (D-25, note-options "Reveal in
 * navigation"). Unlike expandAndScrollToFolder, ancestor expansion is not
 * done manually here — react-arborist's own scrollTo() already calls
 * openParents() internally (tree-api.ts), which dispatches onToggle for
 * each opened ancestor; FileTree's onToggle handler mirrors that back into
 * useTreeStore's persisted `expanded` set, so the ancestor chain ends up
 * expanded AND persisted with no separate step.
 *
 * Retries briefly (bounded, no fixed sleep) if the tree isn't mounted yet —
 * e.g. the left sidebar was showing Search/Bookmarks a moment ago and the
 * caller just flipped sidebarPanel to "notes"; FileTree registers
 * currentTreeRef on mount, one render after that state change.
 */
export function scrollToNoteRow(noteId: string, retriesLeft = 10): void {
  const id = "note:" + noteId;
  if (currentTreeRef) {
    try {
      void currentTreeRef.scrollTo(id, "auto");
    } catch {
      // FileTree may be unmounted or arborist API mismatch — ignore.
    }
    return;
  }
  if (retriesLeft <= 0) return;
  setTimeout(() => scrollToNoteRow(noteId, retriesLeft - 1), 30);
}

/**
 * Reads a note node's updated_at/created ISO timestamp and returns its
 * epoch milliseconds, or 0 when absent/unparseable (folders, file nodes,
 * and notes with no captured birthtime all fall back to 0 — comparatorFor's
 * name tie-break then decides their relative order deterministically).
 */
function timestampOf(
  node: ArboristNode,
  field: "updated_at" | "created",
): number {
  if (node.data.kind !== "note") return 0;
  const value = node.data[field];
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * comparatorFor — the non-folder (notes + files) half of sortTree's D-02
 * six-order contract. Every branch tie-breaks on name A→Z for stable,
 * deterministic ordering when timestamps are equal or absent.
 */
export function comparatorFor(
  order: NotesSortOrder,
): (a: ArboristNode, b: ArboristNode) => number {
  switch (order) {
    case "name-asc":
      return (a, b) => a.name.localeCompare(b.name);
    case "name-desc":
      return (a, b) => b.name.localeCompare(a.name);
    case "modified-desc":
      return (a, b) =>
        timestampOf(b, "updated_at") - timestampOf(a, "updated_at") ||
        a.name.localeCompare(b.name);
    case "modified-asc":
      return (a, b) =>
        timestampOf(a, "updated_at") - timestampOf(b, "updated_at") ||
        a.name.localeCompare(b.name);
    case "created-desc":
      return (a, b) =>
        timestampOf(b, "created") - timestampOf(a, "created") ||
        a.name.localeCompare(b.name);
    case "created-asc":
      return (a, b) =>
        timestampOf(a, "created") - timestampOf(b, "created") ||
        a.name.localeCompare(b.name);
    default:
      return (a, b) => a.name.localeCompare(b.name);
  }
}

/**
 * sortTree — folder-grouping comparator (D-01/D-02). Folders ALWAYS sort
 * A→Z and ALWAYS precede notes/files at every level; only the non-folder
 * group reorders per `order`. Recurses into every folder's children so
 * nested levels apply the same order. Returns new arrays/objects rather
 * than mutating the input nodes (safe to call from a React render/memo).
 */
export function sortTree(
  nodes: ArboristNode[],
  order: NotesSortOrder,
): ArboristNode[] {
  const folders = nodes.filter((n) => n.data.kind === "folder");
  const rest = nodes.filter((n) => n.data.kind !== "folder"); // notes + files
  const sortedFolders = [...folders].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const sortedRest = [...rest].sort(comparatorFor(order));
  const recursedFolders = sortedFolders.map((f) =>
    f.children ? { ...f, children: sortTree(f.children, order) } : f,
  );
  return [...recursedFolders, ...sortedRest];
}
