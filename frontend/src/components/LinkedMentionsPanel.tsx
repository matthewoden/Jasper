/**
 * LinkedMentionsPanel — body-only linked-mentions card list (Phase 20 rename
 * of BacklinksRail, RSIDE-02).
 *
 * No own header, no × close button — SectionHeader (RightRail.tsx) wraps this
 * component. One <li> card per linking note (row.sourceId), title button in
 * var(--color-accent) (never the literal mockup hex), stacked per-mention
 * excerpts sanitized individually — never join-then-sanitize (T-20-07).
 *
 * Card click uses useTabStore.getState().openTab(row.sourceId) (D-15) — NOT
 * the legacy active-note setter, which this rename retires from this surface.
 */
import { sanitizeHtml } from "../lib/sanitize";
import { useBacklinks } from "../lib/useBacklinks";
import { useTabStore } from "../lib/useTabStore";

interface Props {
  /** UUID of the currently open note. Null when no note is open. */
  noteId: string | null;
}

export function LinkedMentionsPanel({ noteId }: Props) {
  const { backlinks, loading, error } = useBacklinks(noteId);

  const emptyState = (
    <div>
      <div
        style={{
          padding: "24px 16px",
          textAlign: "center",
          fontSize: 12,
          color: "var(--color-muted)",
        }}
      >
        No backlinks found
      </div>
      <div
        style={{
          padding: "0 16px 24px",
          textAlign: "center",
          fontSize: 12,
          color: "var(--color-muted)",
        }}
      >
        Notes that link here with [[wiki-links]] will appear here.
      </div>
    </div>
  );

  return (
    <div
      role="region"
      aria-label="Notes that link to this note"
      style={{ height: "100%", overflowY: "auto" }}
    >
      {noteId === null ? (
        emptyState
      ) : loading ? (
        <div
          style={{
            padding: "16px",
            fontSize: 12,
            color: "var(--color-muted)",
          }}
        >
          Loading&hellip;
        </div>
      ) : error ? (
        <div
          style={{
            padding: "16px",
            fontSize: 12,
            color: "var(--color-destructive, #c0392b)",
          }}
        >
          {error.message}
        </div>
      ) : backlinks && backlinks.length === 0 ? (
        emptyState
      ) : (
        <ul role="list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {backlinks?.map((row, i) => (
            <li
              key={row.sourceId}
              className="backlinks-row"
              style={{
                padding: "8px 16px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                borderBottom:
                  backlinks && i < backlinks.length - 1
                    ? "1px solid var(--color-border-inner)"
                    : undefined,
              }}
            >
              <button
                type="button"
                aria-label={`Open note: ${row.sourceTitle}`}
                onClick={() => useTabStore.getState().openTab(row.sourceId)}
                style={{
                  background: "transparent",
                  border: 0,
                  padding: 0,
                  textAlign: "left",
                  cursor: "pointer",
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--color-accent)",
                }}
              >
                {row.sourceTitle}
              </button>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {row.excerpts.map((excerpt, j) => (
                  <div
                    key={j}
                    className="backlinks-excerpt"
                    style={{
                      fontSize: 13,
                      color: "var(--color-muted)",
                      lineHeight: 1.5,
                    }}
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(excerpt) }}
                  />
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
