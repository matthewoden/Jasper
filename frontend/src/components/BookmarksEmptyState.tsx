/**
 * Bookmarks empty state — Phase 27 BOOK-05.
 *
 * Rendered by BookmarksPanel ONLY when the bookmarks slice is empty.
 * Near-verbatim structural copy of TreeEmptyState.tsx (left-aligned, 24px/16px
 * padding, same two-line Body/Label typography), swapping the copy + glyph
 * per the UI-SPEC Copywriting Contract: the inline "Press [+]" icon becomes
 * an inline lucide Star standing in for the ★ glyph.
 *
 * Locked copy (verbatim):
 *   "No bookmarks yet."
 *   "Click the star ★ in a note's header to bookmark it."
 */
import { Star } from "lucide-react";

export function BookmarksEmptyState() {
  return (
    <div
      className="flex flex-col items-start"
      style={{
        padding: "var(--spacing-lg, 24px) var(--spacing-md, 16px)",
        paddingTop: "var(--spacing-lg, 24px)",
      }}
      data-testid="bookmarks-empty-state"
    >
      <p
        style={{
          fontSize: 14,
          fontWeight: 400,
          color: "var(--color-fg)",
          margin: 0,
          marginBottom: "var(--spacing-sm, 8px)",
          lineHeight: 1.5,
        }}
      >
        No bookmarks yet.
      </p>
      <p
        style={{
          fontSize: 14,
          fontWeight: 400,
          color: "var(--color-muted)",
          margin: 0,
          lineHeight: 1.5,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          flexWrap: "wrap",
        }}
      >
        <span>Click the star</span>
        <Star
          size={12}
          aria-hidden="true"
          style={{ display: "inline-block", color: "var(--color-muted)" }}
        />
        <span>in a note&apos;s header to bookmark it.</span>
      </p>
    </div>
  );
}
