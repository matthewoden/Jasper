/**
 * Bookmarks-fetch error state. Exists because a failed GET silently rendered
 * the EMPTY state — getBookmarks swallows its errors.
 *
 * Structural clone of TreeErrorState, swapping only the copy.
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
