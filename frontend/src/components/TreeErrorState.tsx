/**
 * Tree-fetch error state — UI-SPEC §Surface 1 §Error state.
 *
 * Locked copy (verbatim):
 *   Headline:   "Couldn't load the tree."   (text-destructive)
 *   Action btn: "Try again"                  (28px tall, 1px border-border)
 *
 * Container exposes role="alert" so screen readers announce the failure.
 * The Try-again button is intentionally sized SMALLER (28px) than the
 * dialog buttons (32px) because it's an inline-tree affordance, not a
 * primary surface — UI-SPEC §Surface 1 §Error state.
 */

export interface TreeErrorStateProps {
  onRetry: () => void;
}

export function TreeErrorState({ onRetry }: TreeErrorStateProps) {
  return (
    <div
      className="flex flex-col items-start"
      style={{
        padding: "var(--spacing-lg, 24px) var(--spacing-md, 16px)",
      }}
      role="alert"
      data-testid="tree-error-state"
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
        Couldn't load the tree.
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
