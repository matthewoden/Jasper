/**
 * LinkedMentionsPanel — one card per linking note, with per-mention excerpts
 * sanitized INDIVIDUALLY, never joined first. Below the cards, the foreign
 * references the note itself makes, grouped by namespace and shown raw:
 * until a gateway exists they resolve nowhere, so the raw id is the truth.
 *
 * Backlink data arrives as props from RightRail's single useBacklinks call. This
 * component must NOT fetch: two callers would issue duplicate requests and could
 * render disagreeing counts.
 */
import { sanitizeHtml } from "../lib/sanitize";
import type { BacklinkRow } from "../lib/backlinksApi";
import { groupForeignRefs, type NoteRef } from "../lib/itemsApi";
import { usePaneStore } from "../lib/usePaneStore";

interface Props {
  /** Id of the currently open note. Null when no note is open. */
  noteId: string | null;
  /** Backlink rows from RightRail's shared useBacklinks fetch. */
  backlinks: BacklinkRow[] | null;
  loading: boolean;
  error: Error | null;
  /** The note's own references, from RightRail's shared noteRefs fetch. */
  refs?: NoteRef[] | null;
}

export function LinkedMentionsPanel({ noteId, backlinks, loading, error, refs }: Props) {
  const foreign = groupForeignRefs(refs);
  const hasBacklinks = !!backlinks && backlinks.length > 0;

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

  const foreignSection = foreign.length > 0 && (
    <section aria-label="Foreign references" data-testid="foreign-refs" style={{ padding: "8px 24px 16px" }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--color-muted)",
          margin: "8px 0",
        }}
      >
        Foreign references
      </div>
      {foreign.map(([ns, rows]) => (
        <div key={ns} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, color: "var(--color-muted)", marginBottom: 2 }}>{ns}</div>
          <ul role="list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {rows.map((r) => (
              <li
                key={r.target_ref}
                className="foreign-ref-row"
                style={{ fontSize: 13, lineHeight: 1.6, display: "flex", gap: 8, alignItems: "baseline" }}
              >
                <code style={{ fontSize: 12 }}>{r.target_ref}</code>
                {r.display && (
                  <span style={{ color: "var(--color-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.display}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
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
      ) : (
        <>
          {hasBacklinks ? (
            <ul role="list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {backlinks?.map((row, i) => (
                <li
                  key={row.sourceId}
                  className="backlinks-row"
                  style={{
                    padding: "8px 24px",
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
                    onClick={() => usePaneStore.getState().openInActivePane(row.sourceId)}
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
          ) : backlinks && foreign.length === 0 ? (
            emptyState
          ) : null}
          {foreignSection}
        </>
      )}
    </div>
  );
}
