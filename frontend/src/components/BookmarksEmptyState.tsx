/**
 * Bookmarks empty state (BOOK-05). Structural copy of TreeEmptyState with its
 * own copy and an inline Star standing in for the ★ glyph.
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
