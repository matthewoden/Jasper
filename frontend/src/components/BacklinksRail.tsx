/**
 * BacklinksRail — backlinks panel with floating panel card shell.
 *
 * Excerpt HTML from the server is passed through sanitize.ts before
 * dangerouslySetInnerHTML to prevent XSS.
 */
import { X } from "lucide-react";

import { sanitizeHtml } from "../lib/sanitize";
import { useBacklinks } from "../lib/useBacklinks";
import { useTreeStore } from "../lib/useTreeStore";

interface Props {
  /** UUID of the currently open note. Null when no note is open. */
  noteId: string | null;
}

export function BacklinksRail({ noteId }: Props) {
  const setActiveNoteId = useTreeStore((s) => s.setActiveNote);
  const setPanelSelector = useTreeStore((s) => s.setPanelSelector);
  const { backlinks, loading, error } = useBacklinks(noteId);

  const backlinksCount = backlinks?.length ?? 0;

  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      <div
        role="region"
        aria-label="Notes that link to this note"
        style={{ display: "flex", flexDirection: "column", height: "100%" }}
      >
        <header
          style={{
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 16px",
            borderBottom: "1px solid var(--color-border)",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--color-muted)",
              letterSpacing: "0.05em",
            }}
          >
            Linked from {backlinksCount > 0 ? `(${backlinksCount})` : ""}
          </span>
          {/* × close button — removes panel from rail via panelSelector.
              Rail auto-collapses when all panels are deselected (RightRail useEffect). */}
          <button
            type="button"
            aria-label="Close Backlinks panel"
            title="Close Backlinks panel"
            onClick={() => setPanelSelector({ backlinks: false })}
            style={{
              width: 24,
              height: 24,
              background: "transparent",
              border: 0,
              color: "var(--color-muted)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
          {noteId === null ? (
            <div
              style={{
                padding: "24px 16px",
                textAlign: "center",
                fontSize: 12,
                color: "var(--color-muted)",
              }}
            >
              No notes link here yet.
            </div>
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
            <div
              style={{
                padding: "24px 16px",
                textAlign: "center",
                fontSize: 12,
                color: "var(--color-muted)",
              }}
            >
              No notes link here yet.
            </div>
          ) : (
            <ul
              role="list"
              style={{ listStyle: "none", padding: 0, margin: 0 }}
            >
              {backlinks?.map((row) => (
                <li
                  key={row.sourceId}
                  className="backlinks-row"
                  style={{
                    padding: "8px 16px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <button
                    type="button"
                    aria-label={`Open note: ${row.sourceTitle}`}
                    onClick={() => setActiveNoteId(row.sourceId)}
                    style={{
                      background: "transparent",
                      border: 0,
                      padding: 0,
                      textAlign: "left",
                      cursor: "pointer",
                      fontSize: 14,
                      fontWeight: 600,
                      color: "var(--color-fg)",
                    }}
                  >
                    {row.sourceTitle}
                  </button>
                  {row.excerpts.map((excerpt, i) => (
                    <div
                      key={i}
                      className="backlinks-excerpt"
                      style={{
                        fontSize: 13,
                        color: "var(--color-muted)",
                        lineHeight: 1.5,
                      }}
                      dangerouslySetInnerHTML={{ __html: sanitizeHtml(excerpt) }}
                    />
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
