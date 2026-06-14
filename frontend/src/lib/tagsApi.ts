/**
 * tagsApi — typed wrappers over the tag endpoints.
 * All requests route through the openapi-fetch client; no hand-written request shapes.
 * Each wrapper throws on non-2xx so callers can use try/catch.
 *
 * Endpoints:
 *   GET    /api/v1/tags              → listTags(): TagWithCount[]
 *   GET    /api/v1/tags/{name}/notes → listTagNotes(name): NoteSummary[]
 *   PUT    /api/v1/tags/{name}       → renameTag(old, new): TagRenameResponse
 *   DELETE /api/v1/tags/{name}       → deleteTag(name): TagDeleteResponse
 */

import { client } from "../api/client";
import type { components } from "../api/schema";

export type TagWithCount = components["schemas"]["TagWithCount"];
export type TagRenameResponse = components["schemas"]["TagRenameResponse"];
export type TagDeleteResponse = components["schemas"]["TagDeleteResponse"];
export type NoteSummary = components["schemas"]["NoteSummary"];

/** List all tags with note counts, sorted alphabetically. */
export async function listTags(): Promise<TagWithCount[]> {
  const { data, error } = await client.GET("/tags");
  if (error) {
    const msg =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : JSON.stringify(error);
    throw new Error("listTags: " + msg);
  }
  return data.tags;
}

/**
 * List notes carrying a specific tag. Returns 404 if the tag does not exist.
 */
export async function listTagNotes(name: string): Promise<NoteSummary[]> {
  const { data, error } = await client.GET("/tags/{name}/notes", {
    params: { path: { name } },
  });
  if (error) {
    const msg =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : JSON.stringify(error);
    throw new Error("listTagNotes: " + msg);
  }
  return data.notes;
}

/**
 * Rename a tag across all notes. Rewrites frontmatter in a single backend
 * transaction; returns the list of touched note IDs.
 */
export async function renameTag(
  oldName: string,
  newName: string,
): Promise<TagRenameResponse> {
  const { data, error } = await client.PUT("/tags/{name}", {
    params: { path: { name: oldName } },
    body: { new_name: newName },
  });
  if (error) {
    const msg =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : JSON.stringify(error);
    throw new Error("renameTag: " + msg);
  }
  return data;
}

/**
 * Remove a tag from all notes. Drops the tag from frontmatter in a single
 * transaction; returns the list of touched note IDs.
 */
export async function deleteTag(name: string): Promise<TagDeleteResponse> {
  const { data, error } = await client.DELETE("/tags/{name}", {
    params: { path: { name } },
  });
  if (error) {
    const msg =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : JSON.stringify(error);
    throw new Error("deleteTag: " + msg);
  }
  return data;
}
