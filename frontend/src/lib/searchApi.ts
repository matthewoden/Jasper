import { client } from "../api/client";
import type { components } from "../api/schema";

export type SearchResult = components["schemas"]["SearchResult"];

/**
 * searchNotes — GET /api/v1/search (SEARCH-01..04).
 * Calls the FTS5 backend (Plan 07-04). Returns up to `limit` results sorted
 * by bm25 + recency. Tag filter AND-combines per D-05.
 */
export async function searchNotes(
  q: string,
  tag?: string,
  limit: number = 50,
): Promise<SearchResult[]> {
  const { data, error } = await client.GET("/search", {
    params: {
      query: {
        q,
        ...(tag ? { tag } : {}),
        limit,
      },
    },
  });
  if (error) {
    throw new Error("searchNotes: " + JSON.stringify(error));
  }
  return data?.results ?? [];
}
