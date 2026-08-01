import { client } from "../api/client";
import type { components } from "../api/schema";
import { createKeyedResource } from "./resources";

export type SearchResult = components["schemas"]["SearchResult"];

/** Result ordering (SORT-02) — mirrors useTreeStore's SearchSortOrder union. */
export type SearchSort = "relevance" | "modified" | "created";

async function fetchSearch(
  q: string,
  tags: string[] | undefined,
  limit: number,
  sort: SearchSort | undefined,
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

// D-05: /search keeps its own 200ms debounce in useSearch.ts — the layer
// does not absorb it. Pass-through here means coalesced but never cached,
// so two identical concurrent queries still collapse to one request. The
// dedupe key encodes every param (D-05a) — q/tags/limit/sort each vary the
// result set, so the key must too.
const searchResource = createKeyedResource(
  "search",
  (key: string) => {
    const [q, tags, limit, sort] = JSON.parse(key) as [
      string,
      string[] | null,
      number | null,
      SearchSort | null,
    ];
    return fetchSearch(q, tags ?? undefined, limit ?? 50, sort ?? undefined);
  },
  { mode: "pass-through" },
);

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
  const key = JSON.stringify([q, tags ?? null, limit ?? null, sort ?? null]);
  return searchResource.forKey(key).read();
}
