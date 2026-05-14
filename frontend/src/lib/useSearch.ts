import { useEffect, useRef } from "react";
import { useTreeStore } from "./useTreeStore";
import { searchNotes } from "./searchApi";

// INTENTIONAL DESIGN: Search results are NOT refreshed on WS note:* events.
// This is a deliberate divergence from the Phase 4 WS-as-cache-invalidation
// model (CONTEXT.md D-08). Rationale: search is a transient mode; re-running
// on every rapid edit causes thrash. Results reflect state at typing time.
// To see updated results, the user retypes or presses Esc and searches again.
// DO NOT "fix" this by adding a note:* event listener to useSearch.
// See: .planning/phases/07-search-daily-notes-attachments-palette-switcher/07-CONTEXT.md §D-08

const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

/**
 * useSearch — debounced text search with optional tag-AND combination.
 * Reads searchQuery + activeTagFilter from useTreeStore.
 * Writes searchResults + searchActive (Plan 07-07 slices).
 * Returns { isSearching: boolean } for UI feedback hooks (loading state UI per
 * UI-SPEC §States: NO spinner — old results stay visible).
 */
export function useSearch(): { isSearching: boolean } {
  const searchQuery = useTreeStore((s) => s.searchQuery);
  const activeTagFilter = useTreeStore((s) => s.activeTagFilter);
  const setSearchResults = useTreeStore((s) => s.setSearchResults);
  const setSearchActive = useTreeStore((s) => s.setSearchActive);
  const cancelled = useRef(false);
  const isSearchingRef = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  useEffect(() => {
    // Below threshold: clear synchronously, no debounce.
    if (searchQuery.length < MIN_QUERY_LENGTH) {
      setSearchResults([]);
      setSearchActive(false);
      return;
    }
    setSearchActive(true);

    const handle = setTimeout(async () => {
      isSearchingRef.current = true;
      try {
        const results = await searchNotes(
          searchQuery,
          activeTagFilter ?? undefined,
          50,
        );
        if (!cancelled.current) {
          setSearchResults(results);
        }
      } catch (e) {
        // Per UI-SPEC §States, errors trigger toast — but debounce-driven errors
        // simply leave the OLD results visible. v1 lean: silent fail (UI-SPEC line
        // "OLD results stay visible (no spinner)").
        console.warn("useSearch: search failed", e);
      } finally {
        isSearchingRef.current = false;
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [searchQuery, activeTagFilter, setSearchResults, setSearchActive]);

  return { isSearching: isSearchingRef.current };
}
