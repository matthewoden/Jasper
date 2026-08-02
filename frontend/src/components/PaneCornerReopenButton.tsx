/**
 * PaneCornerReopenButton — the reopen affordance for a collapsed left sidebar
 * (NAV-03).
 *
 * Rendered IN-FLOW as the first cell of the top-left leaf's tab strip, so it
 * reserves space and the tabs sit beside it rather than under it.
 *
 * Same PanelLeft glyph as the sidebar's own collapse control, so the two read as
 * one affordance toggling state.
 */
import { useState } from "react";
import { PanelLeft } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";
import { Tooltip } from "./Tooltip";

export function PaneCornerReopenButton(): React.JSX.Element | null {
  const notesSidebarVisible = useTreeStore((s) => s.notesSidebarVisible);
  const setNotesSidebarVisible = useTreeStore((s) => s.setNotesSidebarVisible);
  const [hovering, setHovering] = useState(false);

  if (notesSidebarVisible) return null;

  return (
    <Tooltip label="Show sidebar">
      <button
        type="button"
        aria-label="Show sidebar"
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
    </Tooltip>
  );
}
