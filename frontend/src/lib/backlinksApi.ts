/**
 * backlinksApi — typed wrapper over GET /api/v1/notes/{id}/backlinks.
 *
 * Part of Plan 06-11 (LINKS-08): data wiring for the backlinks rail.
 *
 * Uses the shared openapi-fetch client (same session middleware as all other
 * API modules) and maps the snake_case OpenAPI response to camelCase for TS.
 */

import { client } from "../api/client";
import type { components } from "../api/schema";

/** Camel-case mirror of the OpenAPI BacklinkRow schema. */
export interface BacklinkRow {
  sourceId: string;
  sourceTitle: string;
  sourcePath: string;
  /**
   * Server-built HTML excerpt; MUST be passed through sanitize.ts before
   * dangerouslySetInnerHTML (T-06-11-01). BacklinksRail handles this.
   */
  excerpt: string;
  /** Number of distinct [[...]] references in the source note. */
  count: number;
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
export async function getNoteBacklinks(noteId: string): Promise<BacklinkRow[]> {
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
    excerpt: r.excerpt,
    count: r.count ?? 1,
  }));
}
