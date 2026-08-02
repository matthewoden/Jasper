/**
 * backlinksApi — typed wrapper over GET /api/v1/notes/{id}/backlinks, and
 * the keyed shared-cache resource that backs useBacklinks.
 * Maps the snake_case OpenAPI response to camelCase for TypeScript consumers.
 */

import { client } from "../api/client";
import type { components } from "../api/schema";
import { createKeyedResource } from "./resources";

/** Camel-case mirror of the OpenAPI BacklinkRow schema. */
export interface BacklinkRow {
  sourceId: string;
  sourceTitle: string;
  sourcePath: string;
  /**
   * One server-built HTML excerpt per matching `[[...]]` mention line, in
   * document order. EACH element MUST be passed through sanitize.ts
   * individually before dangerouslySetInnerHTML — never join the array
   * before sanitizing. BacklinksRail handles this per-element.
   */
  excerpts: string[];
}

type RawBacklinkRow = components["schemas"]["BacklinkRow"];

/**
 * Fetch the resolved backlinks for a note.
 *
 * Returns 404-shaped error when the note is not found (indexer not ready or
 * UUID does not exist). Callers should handle the thrown error and show an
 * appropriate empty state rather than surfacing the error to the user as a
 * crash.
 */
async function getNoteBacklinks(noteId: string): Promise<BacklinkRow[]> {
  const { data, error } = await client.GET("/notes/{id}/backlinks", {
    params: { path: { id: noteId } },
  });
  if (error) {
    const msg =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : JSON.stringify(error);
    throw new Error("getNoteBacklinks: " + msg);
  }
  return (data.backlinks as RawBacklinkRow[]).map((r) => ({
    sourceId: r.source_id,
    sourceTitle: r.source_title,
    sourcePath: r.source_path,
    excerpts: r.excerpts,
  }));
}

/**
 * Backlinks are keyed by note id, single-slot — only the active
 * note's entry is retained. Events that invalidate:
 *   - note:updated    — a save anywhere could change [[...]] content
 *   - note:created    — a new note might link to the current one
 *   - links:rewritten — a rename propagated link text changes
 * tags:rewritten is intentionally EXCLUDED: tag rewrites do not affect
 * [[wiki-link]] content and would over-trigger fetches.
 */
export const backlinksResource = createKeyedResource(
  "backlinks",
  getNoteBacklinks,
  {
    mode: "cached",
    invalidatedBy: ["note:updated", "note:created", "links:rewritten"],
  },
);
