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
 *      void for deletes).
 *   3. On error, throws a TreeMutationError carrying { code, message,
 *      status } so callers (Plan 03-07 toast layer) can branch on the
 *      server's locked codes — `case_collision`, `folder_not_empty`,
 *      `invalid_request`, `not_found` (UI-SPEC §Surface 5).
 *
 * The hook does NOT auto-refresh the file tree. The caller (Plan 03-07)
 * decides whether to call useFileTree's refresh() (after create / delete)
 * or mutate() (drag-drop optimistic update + rollback on throw). This
 * separation keeps the optimistic-update knob available without baking
 * data-flow choices into this layer.
 */
import { useCallback } from "react";

import * as treeApi from "./treeApi";

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
      return r.data as treeApi.NoteSummary;
    },
    [],
  );

  const deleteNote = useCallback(async (id: string): Promise<void> => {
    throwOnError(await treeApi.deleteNoteById(id));
  }, []);

  const moveNote = useCallback(
    async (id: string, newPath: string): Promise<treeApi.NoteSummary> => {
      const r = throwOnError(await treeApi.postNoteMove(id, newPath));
      return r.data as treeApi.NoteSummary;
    },
    [],
  );

  const createFolder = useCallback(
    async (parentPath: string, name: string): Promise<treeApi.FolderNode> => {
      const r = throwOnError(
        await treeApi.postFolders({ parent_path: parentPath, name }),
      );
      return r.data as treeApi.FolderNode;
    },
    [],
  );

  const deleteFolder = useCallback(
    async (path: string, recursive: boolean): Promise<void> => {
      throwOnError(await treeApi.deleteFolder(path, recursive));
    },
    [],
  );

  const moveFolder = useCallback(
    async (
      oldPath: string,
      newPath: string,
    ): Promise<treeApi.FolderNode> => {
      const r = throwOnError(await treeApi.postFolderMove(oldPath, newPath));
      return r.data as treeApi.FolderNode;
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
  };
}
