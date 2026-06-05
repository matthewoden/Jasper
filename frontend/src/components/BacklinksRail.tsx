/**
 * Phase 6.5 — Plan 06.5-04 (Surface 3-NEW): BacklinksRail — backlinks panel
 * with floating panel card shell.
 *
 * Phase 6 body is unchanged (header, rows, excerpt sanitization, empty states).
 * Phase 6.5 wraps the entire component in the floating panel card aesthetic
 * per Surface 1-NEW panel card spec:
 *   - background: var(--color-surface)
 *   - border: 1px solid var(--color-border)
 *   - border-radius: 8px (matches dialog radius)
 *   - overflow: hidden (child content respects rounded corners)
 *
 * Count badge in header: D-34 decision — YES, add ({N}) for symmetry with
 * the Tags panel. The count comes from useBacklinks.backlinks.length which
 * is already fetched. Zero cost — no extra query needed.
 *
 * Data source: useBacklinks(noteId) fetches GET /api/v1/notes/{id}/backlinks
 * and refetches on note:updated, note:created, links:rewritten WS events.
 *
 * Security: excerpt HTML from the server is passed through sanitize.ts before
 * dangerouslySetInnerHTML (T-06-11-01 / Phase 5 D-36 SAFE_CONFIG).
 *
 * Aria contract (updated from Phase 6):
 *   - role="region" aria-label="Notes that link to this note"
 *   - Hide button: aria-label="Hide backlinks panel" aria-expanded={true}
 *   - Outer panel: aria-label updated per UI-SPEC §Surface 3-NEW
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
            {/* D-34: show count for symmetry with Tags panel */}
            Linked from {backlinksCount > 0 ? `(${backlinksCount})` : ""}
          </span>
          {/* Phase 6.6 (D-04): × close button — removes panel from rail via panelSelector.
              UAT follow-up 2026-05-12: rail-level collapse button removed; rail auto-collapses
              when all panels are deselected (RightRail useEffect). */}
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
                  {/* D-27: source title is a button that opens the source note. */}
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
                    {/* D-29: count badge when N > 1. */}
                    {row.count > 1 && (
                      <span
                        style={{
                          color: "var(--color-muted)",
                          fontWeight: 400,
                          marginLeft: 4,
                        }}
                      >
                        &middot;{row.count}
                      </span>
                    )}
                  </button>
                  {/* D-27: sanitized excerpt with <mark class="backlink-ref"> highlighted. */}
                  <div
                    className="backlinks-excerpt"
                    style={{
                      fontSize: 13,
                      color: "var(--color-muted)",
                      lineHeight: 1.5,
                    }}
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(row.excerpt) }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
