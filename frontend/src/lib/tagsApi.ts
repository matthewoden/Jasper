/**
 * tagsApi — typed wrappers over the Phase 6 tag endpoints.
 *
 * All requests route through the openapi-fetch client (frontend/src/api/client.ts),
 * which is bound to the generated `paths` from Plan 06-02's spec extension.
 * ZERO hand-written request shapes — mirrors the pattern established in notesApi.ts
 * and treeApi.ts.
 *
 * Each wrapper throws an Error on non-2xx responses so callers can use
 * try/catch rather than destructuring { data, error }.
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

/**
 * List all tags with note counts, sorted alphabetically.
 * Feeds the sidebar tag browser (D-01..D-03) and tag autocomplete (D-07).
 */
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
 * List notes carrying a specific tag (TAGS-04 / D-02 flat list).
 * Returns 404 if the tag does not exist.
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
 * Rename a tag across all notes (TAGS-06 / D-23).
 * Rewrites frontmatter in a single backend transaction.
 * Returns the list of touched note IDs so the caller can decide whether to toast.
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
 * Remove a tag from all notes (TAGS-07 / D-24).
 * Drops the tag from frontmatter in a single transaction.
 * Returns the list of touched note IDs so the caller can decide whether to toast.
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
