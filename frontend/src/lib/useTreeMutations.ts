/**
 * useTreeMutations — six per-operation mutation hooks for Phase 3 tree CRUD.
 *
 *   { createNote, deleteNote, moveNote,
 *     createFolder, deleteFolder, moveFolder }
 *
 * Each wrapper:
 *   1. Calls the matching treeApi.* function (ZERO hand-written shapes per
 *      API-03; treeApi already routes through openapi-fetch).
 *   2. On success, returns the typed payload (NoteSummary / FolderNode /
 *      void for deletes) AND calls useFileTree().refresh() so the tree
 *      observed by every consumer reflects the new server state.
 *   3. On error, throws a TreeMutationError carrying { code, message,
 *      status } so callers (Plan 03-07 toast layer) can branch on the
 *      server's locked codes — `case_collision`, `folder_not_empty`,
 *      `invalid_request`, `not_found` (UI-SPEC §Surface 5). On the error
 *      path the throw happens BEFORE the await refresh() line, so a
 *      failed mutation never refreshes — the server is the source of
 *      truth and a failed mutation means the tree did NOT change.
 *
 * Plan 03-09 note (Gap 1): the auto-refresh contract was lifted into
 * this hook so consumers (useTreeCreateActions, FileTree handlers,
 * Sidebar) don't have to remember to thread refresh() after every
 * mutation. The previous "caller chooses refresh-vs-optimistic" design
 * looked correct in unit tests (vitest mocks treeApi), but in the live
 * binary every consumer simply forgot — every successful POST /notes,
 * DELETE /notes/{id}, POST /notes/{id}/move returned 2xx and the
 * server-side GET /tree reflected the change, yet the React tree
 * never repainted until a hard reload.
 */
import { useCallback } from "react";

import * as treeApi from "./treeApi";
import * as filesApi from "./filesApi";
import { broadcastRefresh } from "./useFileTree";

// Plan 07-41 (UAT-6 N2 close-out): moveFile catches 404 and reconciles
// against the post-refresh tree. If the file IS at the expected dst, the
// 404 was a race-repeat (server already completed the move via an earlier
// in-flight dispatch) and the toast is suppressed. If it is NOT, the 404
// represents a real failure and the error propagates so the existing
// surfaceError toast still fires.
//
// Walks the tree DFS; returns true on the first node whose .path equals
// the target. Folders and notes both compare by .path (which is the
// canonical NFC + lowercased path under notes/ per the API contract).
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
  // Plan 07-39 (UAT-5 N2-sub-B): internal file drag wraps filesApi.moveFile
  // with the same single-flight + refresh pattern as moveNote / moveFolder.
  // filesApi.moveFile throws on error (its own Error subclass with .status);
  // we propagate the throw without wrapping in TreeMutationError because the
  // /files endpoint has its own error envelope.
  moveFile: (src: string, dst: string) => Promise<filesApi.MoveFileResult>;
}

export function useTreeMutations(): UseTreeMutationsResult {
  const createNote = useCallback(
    async (parentPath: string, title: string): Promise<treeApi.NoteSummary> => {
      const r = throwOnError(
        await treeApi.postNotes({ parent_path: parentPath, title }),
      );
      // r.data is non-undefined on the success branch (throwOnError ensures
      // we throw before reaching here on error). The non-null assertion is
      // safe and gives the caller a non-optional type.
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
      // filesApi.moveFile throws on non-2xx with .status + .body. The
      // normal pattern (mirror moveNote / moveFolder) is: refresh ONLY on
      // the success path, propagate the error otherwise.
      //
      // Plan 07-41 (UAT-6 N2 close-out) adds a 404-specific reconcile:
      // when a 404 fires, the move MAY have actually succeeded earlier in
      // a race-repeat scenario (Plan 07-40 INVESTIGATION hypothesis #1,
      // confirmed by user repro 2026-05-16). We broadcast a refresh and
      // inspect the resulting tree — if the file is at the expected dst,
      // the 404 was a noop and we swallow it. Otherwise, the existing
      // surfaceError pathway (whichever caller wraps moveFile) gets the
      // throw and the user sees the existing toast. In both branches we
      // emit a console.error breadcrumb so the next occurrence in the
      // wild leaves a client-side trail to pair with the server log.
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
          // Always log so a real occurrence leaves a breadcrumb regardless
          // of which branch (race-repeat vs real-failure) we end up in.
          console.error("[moveFile] 404; refreshing + reconciling", {
            src,
            dst,
            err,
          });
          await broadcastRefresh();
          // Inspect the post-refresh tree directly. We can't rely on
          // useFileTree state here (the wrapper hook isn't subscribed to
          // it), so we hit getTree() which the coalescer single-flights
          // with the broadcast above — so this typically resolves from
          // the same in-flight promise rather than firing a second GET.
          const { data: tree } = await treeApi.getTree();
          if (tree && treeContainsPath(tree.root, dst)) {
            // Race-repeat shape — the move physically completed earlier.
            // Swallow the 404; the tree is already in the desired state
            // and a toast would confuse the user about a successful op.
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
