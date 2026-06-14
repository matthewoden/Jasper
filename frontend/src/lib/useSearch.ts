import { useEffect, useRef, useState } from "react";
import { searchNotes, type SearchResult } from "./searchApi";


const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

export interface PaletteSearchResult {
  results: SearchResult[];
  isSearching: boolean;
}

/**
 * useSearch — debounced full-text search with optional tag-AND filter.
 * Caller supplies query + activeTagFilter; hook returns { results, isSearching }.
 * No store writes. Mounted inside CommandMenu when mode === "notes".
 *
 * Below 2-character threshold: returns empty results synchronously (no debounce).
 * Above threshold: debounces 200ms then fires searchNotes(query, activeTagFilter, 50).
 * 200ms chosen over 500ms because the activity indicator covers in-window feedback.
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
        console.warn("useSearch: search failed", e);
      } finally {
        if (!cancelled.current) setIsSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, activeTagFilter]);

  return { results, isSearching };
}
