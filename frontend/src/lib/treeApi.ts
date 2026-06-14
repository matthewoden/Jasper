/**
 * Typed wrappers over the tree/note/folder endpoints.
 * All requests go through the openapi-fetch client; no hand-written request shapes.
 *
 * Each wrapper returns { data } on success or { error: { code, message, status } }
 * on failure so callers can distinguish 404 / 409 / 500 without re-parsing the body.
 */
import { client } from "../api/client";
import type { components } from "../api/schema";

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

export async function getTree(): Promise<{ data?: Tree; error?: ApiError }> {
  const { data, error, response } = await client.GET("/tree");
  if (error) return { error: asApiError(error, response.status) };
  return { data };
}

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
