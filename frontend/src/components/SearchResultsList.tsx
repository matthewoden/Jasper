/**
 * SearchResultsList — Phase 7 Surface 3 virtualized results list.
 * UI-SPEC §Surface 3: @tanstack/react-virtual list that replaces FileTree
 * when searchActive=true. Shows up to 50 results (cap) with a footer line
 * when there are exactly 50 (indicating hasMore). Empty state when no matches.
 *
 * Virtualization: useVirtualizer with estimateSize=80, overscan=5.
 * The estimate of 80px is a reasonable default — rows with excerpt take ~88px
 * (12+14+42+12 content + 12+12 padding), rows without excerpt are shorter.
 * @tanstack/react-virtual dynamic measures automatically once mounted.
 */
import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTreeStore } from "../lib/useTreeStore";
import { SearchResultRow } from "./SearchResultRow";

export function SearchResultsList() {
  const searchResults = useTreeStore((s) => s.searchResults);
  const searchQuery = useTreeStore((s) => s.searchQuery);

  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: searchResults.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 5,
  });

  if (searchQuery.length >= 2 && searchResults.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          paddingTop: 48,
          fontSize: 14,
          color: "var(--color-muted)",
          boxSizing: "border-box",
        }}
      >
        {`No matches for "${searchQuery}"`}
      </div>
    );
  }

  const hasMore = searchResults.length === 50;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Scrollable container for the virtualized list */}
      <div
        ref={parentRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
        }}
      >
        {/* Total virtual height container */}
        <div
          style={{
            height: rowVirtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualItem) => {
            const result = searchResults[virtualItem.index];
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <SearchResultRow result={result} />
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer: shown when results are capped at 50 */}
      {hasMore && (
        <div
          style={{
            padding: "12px 16px",
            fontSize: 12,
            color: "var(--color-muted)",
            textAlign: "center",
            borderTop: "1px solid var(--color-border)",
            flexShrink: 0,
          }}
        >
          {`Showing 50 of ${searchResults.length} — refine your search`}
        </div>
      )}
    </div>
  );
}
