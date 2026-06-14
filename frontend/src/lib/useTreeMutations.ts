/**
 * useTreeMutations — typed mutation wrappers for tree CRUD.
 *
 * Each wrapper calls the matching treeApi.* function, then on success returns
 * the typed payload and calls broadcastRefresh() so every consumer sees the new
 * server state. On error, throws a TreeMutationError carrying { code, message,
 * status } for the caller's toast layer. The throw happens before refresh() so
 * a failed mutation never triggers a tree repaint — the server is the source of
 * truth and a failed mutation means the tree did not change.
 *
 * Auto-refresh lives here (not in callers) because the previous "caller chooses
 * refresh-vs-optimistic" pattern was consistently forgotten in practice — mutations
 * returned 2xx but the React tree never repainted until a hard reload.
 */
import { useCallback } from "react";

import * as treeApi from "./treeApi";
import * as filesApi from "./filesApi";
import { broadcastRefresh } from "./useFileTree";


function treeContainsPath(
  nodes: readonly treeApi.TreeNode[] | undefined,
  target: string,
): boolean {
  if (!nodes) return false;
  for (const node of nodes) {
    if (node.path === target) return true;
    if (node.kind === "folder" && node.children) {
      if (treeContainsPath(node.children, target)) return true;
    }
  }
  return false;
}

export class TreeMutationError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "TreeMutationError";
    this.code = code;
    this.status = status;
  }
}

function throwOnError<
  T extends { error?: { code: string; message: string; status: number } },
>(r: T): T {
  if (r.error) {
    throw new TreeMutationError(r.error.code, r.error.message, r.error.status);
  }
  return r;
}

export interface UseTreeMutationsResult {
  createNote: (
    parentPath: string,
    title: string,
  ) => Promise<treeApi.NoteSummary>;
  deleteNote: (id: string) => Promise<void>;
  moveNote: (id: string, newPath: string) => Promise<treeApi.NoteSummary>;
  createFolder: (
    parentPath: string,
    name: string,
  ) => Promise<treeApi.FolderNode>;
  deleteFolder: (path: string, recursive: boolean) => Promise<void>;
  moveFolder: (oldPath: string, newPath: string) => Promise<treeApi.FolderNode>;
  moveFile: (src: string, dst: string) => Promise<filesApi.MoveFileResult>;
}

export function useTreeMutations(): UseTreeMutationsResult {
  const createNote = useCallback(
    async (parentPath: string, title: string): Promise<treeApi.NoteSummary> => {
      const r = throwOnError(
        await treeApi.postNotes({ parent_path: parentPath, title }),
      );
      await broadcastRefresh();
      return r.data as treeApi.NoteSummary;
    },
    [],
  );

  const deleteNote = useCallback(
    async (id: string): Promise<void> => {
      throwOnError(await treeApi.deleteNoteById(id));
      await broadcastRefresh();
    },
    [],
  );

  const moveNote = useCallback(
    async (id: string, newPath: string): Promise<treeApi.NoteSummary> => {
      const r = throwOnError(await treeApi.postNoteMove(id, newPath));
      await broadcastRefresh();
      return r.data as treeApi.NoteSummary;
    },
    [],
  );

  const createFolder = useCallback(
    async (parentPath: string, name: string): Promise<treeApi.FolderNode> => {
      const r = throwOnError(
        await treeApi.postFolders({ parent_path: parentPath, name }),
      );
      await broadcastRefresh();
      return r.data as treeApi.FolderNode;
    },
    [],
  );

  const deleteFolder = useCallback(
    async (path: string, recursive: boolean): Promise<void> => {
      throwOnError(await treeApi.deleteFolder(path, recursive));
      await broadcastRefresh();
    },
    [],
  );

  const moveFolder = useCallback(
    async (
      oldPath: string,
      newPath: string,
    ): Promise<treeApi.FolderNode> => {
      const r = throwOnError(await treeApi.postFolderMove(oldPath, newPath));
      await broadcastRefresh();
      return r.data as treeApi.FolderNode;
    },
    [],
  );

  const moveFile = useCallback(
    async (
      src: string,
      dst: string,
    ): Promise<filesApi.MoveFileResult> => {
      try {
        const data = await filesApi.moveFile(src, dst);
        await broadcastRefresh();
        return data;
      } catch (err) {
        const status =
          err && typeof err === "object" && "status" in err
            ? (err as { status?: number }).status
            : undefined;
        if (status === 404) {
          console.error("[moveFile] 404; refreshing + reconciling", {
            src,
            dst,
            err,
          });
          await broadcastRefresh();
          const { data: tree } = await treeApi.getTree();
          if (tree && treeContainsPath(tree.root, dst)) {
            return { path: dst, name: dst.split("/").pop() ?? dst };
          }
        }
        throw err;
      }
    },
    [],
  );

  return {
    createNote,
    deleteNote,
    moveNote,
    createFolder,
    deleteFolder,
    moveFolder,
    moveFile,
  };
}
