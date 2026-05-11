/**
 * Phase 6 — Plan 06-07 (D-45/D-46): BacklinksRail — backlinks panel chrome.
 *
 * Replaces the Phase 1 BacklinksColumn placeholder. Owns:
 *   - The "Linked from" header (12px/600/muted, letter-spacing 0.05em).
 *   - The scrollable body area.
 *   - The Hide button (ChevronRight) that collapses the rail.
 *   - The empty state when no backlinks exist ("No notes link here yet.").
 *
 * Data wiring (useBacklinks hook + row rendering) is Plan 06-11.
 * This plan ships chrome-only with the empty-state placeholder body.
 *
 * Aria contract (06-UI-SPEC.md §Accessibility Contract):
 *   - role="region" aria-label="Notes that link to this note"
 *   - Hide button: aria-label="Hide backlinks panel" aria-expanded={true}
 */
import { ChevronRight } from "lucide-react";

import { useTreeStore } from "../lib/useTreeStore";

interface Props {
  /** UUID of the currently open note. Plan 06-11 uses this to fetch backlinks. */
  noteId: string | null;
}

export function BacklinksRail(props: Props) {
  // noteId is unused in this plan; Plan 06-11 wires useBacklinks(props.noteId).
  void props.noteId;
  const setExpanded = useTreeStore((s) => s.setBacklinksRailExpanded);

  return (
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
          Linked from
        </span>
        <button
          type="button"
          aria-label="Hide backlinks panel"
          aria-expanded={true}
          title="Hide backlinks panel"
          onClick={() => setExpanded(false)}
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
          <ChevronRight size={16} />
        </button>
      </header>
      <div
        style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}
      >
        {/* Plan 06-11 replaces this placeholder with useBacklinks(noteId) row list. */}
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
      </div>
    </div>
  );
}
