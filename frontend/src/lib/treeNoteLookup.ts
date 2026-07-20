import type { TreeNode } from "./treeApi";

/**
 * Recursively find the canonical relative path of a note by id.
 * Returns null when the id is absent from the tree.
 */
export function findNotePath(
  root: ReadonlyArray<TreeNode>,
  id: string,
): string | null {
  for (const node of root) {
    if (node.kind === "note" && node.id === id) return node.path;
    if (node.kind === "folder" && Array.isArray(node.children)) {
      const found = findNotePath(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Returns the folder portion of a path ("" for a root-level path). */
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Resolve the containing folder path for a note id. Returns "" (vault root,
 * D-06 fallback) when noteId is null, the note is not found, or the note
 * sits at the vault root.
 */
export function getNoteFolder(
  noteId: string | null,
  root: ReadonlyArray<TreeNode>,
): string {
  if (!noteId) return "";
  const path = findNotePath(root, noteId);
  return path !== null ? parentDir(path) : "";
}
