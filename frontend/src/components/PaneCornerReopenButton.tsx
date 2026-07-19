/**
 * PaneCornerReopenButton — reopen affordance for the collapsed left sidebar
 * (NAV-03). Rendered IN-FLOW as the first cell of the top-left leaf's tab
 * strip (see `TabStrip.tsx` / `isTopLeftLeaf`), so it reserves space and the
 * tabs sit beside it instead of under it. Gates on `notesSidebarVisible` —
 * renders nothing when the sidebar is open, matching the mock (a tab-bar left
 * toggle appears only while the sidebar is closed).
 *
 * Same PanelLeft glyph as the sidebar header's collapse icon so collapse and
 * reopen read as one affordance toggling state.
 *
 * Glyph is CENTERED within the 40px-wide cell (owner-picked placement, Phase
 * 27 follow-up final polish) — symmetric margins rather than hard-left, so the
 * reopen affordance reads as balanced in its reserved tab-strip cell. Hover is
 * a compact 28x28 rounded-square tint centered on the glyph (not a full-height
 * rectangle), so the hover reads as a small tag on the glyph itself rather than
 * filling the whole cell.
 *
 * `marginLeft: -4` cancels the parent tab strip's `padding: "0 4px"` (see
 * `tabStripStyle` in TabStrip.tsx): without it the strip's 4px left padding
 * shoves this first cell 4px off the activity ribbon's edge, so the centered
 * glyph landed 4px too far right. Absorbing that padding seats the cell flush
 * against the ribbon so the glyph centers in the intended 40px column.
 */
import { useState } from "react";
import { PanelLeft } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";

export function PaneCornerReopenButton(): React.JSX.Element | null {
  const notesSidebarVisible = useTreeStore((s) => s.notesSidebarVisible);
  const setNotesSidebarVisible = useTreeStore((s) => s.setNotesSidebarVisible);
  const [hovering, setHovering] = useState(false);

  if (notesSidebarVisible) return null;

  return (
    <button
      type="button"
      aria-label="Show sidebar"
      title="Show sidebar"
      onClick={() => setNotesSidebarVisible(true)}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        alignSelf: "stretch",
        flexShrink: 0,
        width: 40,
        marginLeft: -4,
        padding: 0,
        borderTop: "none",
        borderBottom: "none",
        borderLeft: "none",
        borderRight: "1px solid var(--color-border-inner)",
        background: "transparent",
        color: "var(--color-muted)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: hovering
            ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
            : "transparent",
        }}
      >
        <PanelLeft size={16} aria-hidden="true" />
      </span>
    </button>
  );
}
