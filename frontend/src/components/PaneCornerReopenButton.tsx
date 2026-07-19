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
 * Glyph is HARD-LEFT within the 40px-wide cell, inset ~8px to match
 * ActivityRibbon's own internal cell margin (`ribbonStyle.padding: "10px 0"`
 * plus each `RibbonButton`'s own edge) so the icon sits snug against the
 * ribbon's right border with no visible gap (rejected: centering the glyph
 * in the cell read as floating/disconnected — Phase 27 follow-up fix round,
 * item 2 revision). Hover is a compact 28x28 rounded-square tint hugging the
 * glyph at that same hard-left position, not centered in the 40px cell and
 * not a full-height rectangle — so the hover reads as a small tag on the
 * glyph itself rather than filling the reserved tab-strip cell.
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
        padding: 0,
        paddingLeft: 8,
        borderTop: "none",
        borderBottom: "none",
        borderLeft: "none",
        borderRight: "1px solid var(--color-border-inner)",
        background: "transparent",
        color: "var(--color-muted)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "flex-start",
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
