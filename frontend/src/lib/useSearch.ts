import { useEffect, useRef, useState } from "react";
import { searchNotes, type SearchResult } from "./searchApi";

// INTENTIONAL DESIGN: Search results are NOT refreshed on WS note:* events.
// This is a deliberate divergence from the Phase 4 WS-as-cache-invalidation
// model (CONTEXT.md D-08). Rationale: search is a transient mode; re-running
// on every rapid edit causes thrash. Results reflect state at typing time.
// To see updated results, the user retypes or presses Esc and searches again.
// DO NOT "fix" this by adding a note:* event listener to useSearch.
// See: .planning/phases/07-search-daily-notes-attachments-palette-switcher/07-CONTEXT.md §D-08

// Plan 07-44 (UAT-8 follow-up): reverted to 200 from Plan 07-43's 500ms —
// user prefers responsiveness; activity indicator from 07-43 Task 3 covers
// the in-window feedback so the longer debounce was unnecessary.
const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

export interface PaletteSearchResult {
  results: SearchResult[];
  isSearching: boolean;
}

/**
 * useSearch — debounced text search with optional tag-AND combination.
 * Now parameter-driven (post-Plan 07-18 / Bucket B1 pivot): caller supplies
 * query + activeTagFilter; hook returns { results, isSearching }.
 * No store writes. Mounted inside CommandMenu when mode === "notes".
 *
 * Below 2-character threshold: returns { results: [], isSearching: false }
 * synchronously (no debounce, no store writes).
 * Above threshold: debounces 200ms (Plan 07-44 — reverted from Plan 07-43's
 * 500ms after user reversal; activity indicator covers in-window feedback),
 * fires searchNotes(query, activeTagFilter, 50), returns the results when
 * they land.
 */
export function useSearch(
  query: string,
  activeTagFilter: string | null,
): PaletteSearchResult {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  useEffect(() => {
    if (query.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    const handle = setTimeout(async () => {
      try {
        const r = await searchNotes(
          query,
          activeTagFilter ?? undefined,
          50,
        );
        if (!cancelled.current) {
          setResults(r);
        }
      } catch (e) {
        // Per UI-SPEC §States, errors trigger toast — but debounce-driven errors
        // simply leave the OLD results visible. v1 lean: silent fail.
        console.warn("useSearch: search failed", e);
      } finally {
        if (!cancelled.current) setIsSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, activeTagFilter]);

  return { results, isSearching };
}
