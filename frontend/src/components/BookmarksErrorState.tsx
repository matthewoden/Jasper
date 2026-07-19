/**
 * Bookmarks-fetch error state — closes 27-UI-REVIEW finding #1 (a failed
 * GET /bookmarks silently rendered the empty state, since getBookmarks()
 * swallowed all errors). Verbatim structural clone of TreeErrorState.tsx
 * (quick task 260719-jv1, item 5) — same 24px/16px padding, same 28px
 * "Try again" button, same role="alert" — swapping only the locked copy.
 *
 * Locked copy (verbatim):
 *   Headline:   "Couldn't load bookmarks."   (text-destructive)
 *   Action btn: "Try again"                   (28px tall, 1px border-border)
 */

export interface BookmarksErrorStateProps {
  onRetry: () => void;
}

export function BookmarksErrorState({ onRetry }: BookmarksErrorStateProps) {
  return (
    <div
      className="flex flex-col items-start"
      style={{
        padding: "var(--spacing-lg, 24px) var(--spacing-md, 16px)",
      }}
      role="alert"
      data-testid="bookmarks-error-state"
    >
      <p
        style={{
          fontSize: 14,
          fontWeight: 400,
          color: "var(--color-destructive)",
          margin: 0,
          marginBottom: 12,
          lineHeight: 1.5,
        }}
      >
        Couldn&apos;t load bookmarks.
      </p>
      <button
        type="button"
        onClick={onRetry}
        style={{
          height: 28,
          padding: "0 12px",
          background: "transparent",
          border: "1px solid var(--color-border)",
          color: "var(--color-fg)",
          fontSize: 14,
          fontWeight: 400,
          fontFamily: "inherit",
          cursor: "pointer",
          borderRadius: 4,
        }}
      >
        Try again
      </button>
    </div>
  );
}
