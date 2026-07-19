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
        borderTop: "none",
        borderBottom: "none",
        borderLeft: "none",
        borderRight: "1px solid var(--color-border-inner)",
        background: hovering
          ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
          : "transparent",
        color: "var(--color-muted)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <PanelLeft size={16} aria-hidden="true" />
    </button>
  );
}
