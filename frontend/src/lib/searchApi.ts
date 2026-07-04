import { client } from "../api/client";
import type { components } from "../api/schema";

export type SearchResult = components["schemas"]["SearchResult"];

/**
 * searchNotes — GET /api/v1/search.
 * Returns up to `limit` results sorted by bm25 + recency.
 * Tag filters AND-combine with the query (repeat the tag param).
 */
export async function searchNotes(
  q: string,
  tags?: string[],
  limit: number = 50,
): Promise<SearchResult[]> {
  const { data, error } = await client.GET("/search", {
    params: {
      query: {
        q,
        ...(tags && tags.length ? { tag: tags } : {}),
        limit,
      },
    },
  });
  if (error) {
    throw new Error("searchNotes: " + JSON.stringify(error));
  }
  return data?.results ?? [];
}
