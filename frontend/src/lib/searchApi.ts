import { client } from "../api/client";
import type { components } from "../api/schema";

export type SearchResult = components["schemas"]["SearchResult"];

/** Result ordering (SORT-02) — mirrors useTreeStore's SearchSortOrder union. */
export type SearchSort = "relevance" | "modified" | "created";

/**
 * searchNotes — GET /api/v1/search.
 * Returns up to `limit` results sorted by bm25 + recency (default), or by
 * modified/created timestamp DESC when `sort` is set (D-14 true server
 * ordering, not a client reshuffle).
 * Tag filters AND-combine with the query (repeat the tag param).
 */
export async function searchNotes(
  q: string,
  tags?: string[],
  limit: number = 50,
  sort?: SearchSort,
): Promise<SearchResult[]> {
  const { data, error } = await client.GET("/search", {
    params: {
      query: {
        q,
        ...(tags && tags.length ? { tag: tags } : {}),
        limit,
        ...(sort && sort !== "relevance" ? { sort } : {}),
      },
    },
  });
  if (error) {
    throw new Error("searchNotes: " + JSON.stringify(error));
  }
  return data?.results ?? [];
}
