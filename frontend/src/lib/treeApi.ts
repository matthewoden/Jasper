/**
 * Typed wrappers over the tree/note/folder endpoints.
 * All requests go through the openapi-fetch client; no hand-written request shapes.
 *
 * Each wrapper returns { data } on success or { error: { code, message, status } }
 * on failure so callers can distinguish 404 / 409 / 500 without re-parsing the body.
 *
 * GET /tree sits behind treeResource, the shared fetch-once-and-cache primitive
 * (createResource). walkTreeCollect lives here rather than in useFileTree.ts so
 * the fetchTree() wrapper below can prune stale tree-store state once per
 * fetch, not once per subscriber — importing it from useFileTree.ts would
 * cycle back to treeResource.
 */
import { client } from "../api/client";
import type { components } from "../api/schema";
import { createResource } from "./resources";
import { pruneStaleTreeState } from "./useTreeStore";

export type Tree = components["schemas"]["Tree"];
export type TreeNode = components["schemas"]["TreeNode"];
export type FolderNode = components["schemas"]["FolderNode"];
export type NoteNode = components["schemas"]["NoteNode"];

export type FileNode = components["schemas"]["FileNode"];
export type NoteSummary = components["schemas"]["NoteSummary"];

export type ApiError = { code: string; message: string; status: number };

function asApiError(error: unknown, status: number): ApiError {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const e = error as { code: unknown; message: unknown };
    return {
      code: typeof e.code === "string" ? e.code : "unknown",
      message: typeof e.message === "string" ? e.message : "request failed",
      status,
    };
  }
  return { code: "unknown", message: "request failed", status };
}

/** Walk the tree collecting every folder path and note id. */
export function walkTreeCollect(tree: Tree): {
  folders: Set<string>;
  notes: Set<string>;
} {
  const folders = new Set<string>();
  const notes = new Set<string>();
  const visit = (node: TreeNode): void => {
    if (node.kind === "folder") {
      folders.add(node.path);
      if (node.children) {
        for (const child of node.children) visit(child);
      }
    } else if (node.kind === "note") {
      notes.add(node.id);
    }
    // "file" kind nodes have no note id and are not tracked here.
  };
  for (const node of tree.root) visit(node);
  return { folders, notes };
}

// Not module-private: useTreeMutations.ts's moveFile() 404-reconciliation
// path (an imperative D-06-style server-truth read after broadcastRefresh(),
// not a useResource() consumer) calls this directly. Kept exported so that
// file's zero-diff contract holds; treeResource's own fetcher (fetchTree,
// below) still owns the cached/coalesced path every display consumer uses.
export async function getTree(): Promise<{ data?: Tree; error?: ApiError }> {
  const { data, error, response } = await client.GET("/tree");
  if (error) return { error: asApiError(error, response.status) };
  return { data };
}

async function fetchTree(): Promise<{ data?: Tree; error?: ApiError }> {
  const result = await getTree();
  if (result.data) {
    const { folders, notes } = walkTreeCollect(result.data);
    pruneStaleTreeState(folders, notes);
  }
  return result;
}

export const treeResource = createResource("tree", fetchTree, {
  mode: "cached",
  // note:updated is deliberately absent — a body save does not change the
  // tree projection, only the note's content.
  invalidatedBy: [
    "note:created",
    "note:deleted",
    "note:moved",
    "folder:created",
    "folder:deleted",
    "folder:moved",
    "file:created",
    "file:deleted",
    "file:moved",
    "links:rewritten",
    "reindex:complete",
  ],
});

export async function postNotes(
  req: { parent_path: string; title: string },
): Promise<{ data?: NoteSummary; error?: ApiError }> {
  const { data, error, response } = await client.POST("/notes", { body: req });
  if (error) return { error: asApiError(error, response.status) };
  return { data };
}

export async function deleteNoteById(
  id: string,
): Promise<{ error?: ApiError }> {
  const { error, response } = await client.DELETE("/notes/{id}", {
    params: { path: { id } },
  });
  if (error) return { error: asApiError(error, response.status) };
  return {};
}

export async function postNoteMove(
  id: string,
  new_path: string,
): Promise<{ data?: NoteSummary; error?: ApiError }> {
  const { data, error, response } = await client.POST("/notes/{id}/move", {
    params: { path: { id } },
    body: { new_path },
  });
  if (error) return { error: asApiError(error, response.status) };
  return { data };
}

export async function postFolders(
  req: { parent_path: string; name: string },
): Promise<{ data?: FolderNode; error?: ApiError }> {
  const { data, error, response } = await client.POST("/folders", { body: req });
  if (error) return { error: asApiError(error, response.status) };
  return { data };
}

export async function deleteFolder(
  path: string,
  recursive: boolean,
): Promise<{ error?: ApiError }> {
  const { error, response } = await client.DELETE("/folders", {
    params: { query: { path, recursive } },
  });
  if (error) return { error: asApiError(error, response.status) };
  return {};
}

export async function postFolderMove(
  old_path: string,
  new_path: string,
): Promise<{ data?: FolderNode; error?: ApiError }> {
  const { data, error, response } = await client.POST("/folders/move", {
    body: { old_path, new_path },
  });
  if (error) return { error: asApiError(error, response.status) };
  return { data };
}
