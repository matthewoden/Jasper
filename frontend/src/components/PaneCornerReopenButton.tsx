/**
 * PaneCornerReopenButton — net-new reopen affordance for the collapsed left
 * sidebar (NAV-03, D-12). Rendered by `PaneTree` inside the top-left leaf
 * ONLY (see `PaneTree.tsx`'s `topLeftLeafId` threading) — this component
 * itself gates on `notesSidebarVisible` so PaneTree only has to decide WHICH
 * leaf may host it, not whether it's currently visible.
 *
 * Same PanelLeft-family glyph as the sidebar header's collapse icon (D-11,
 * Plan 03) so collapse/reopen reads as one toggle affordance, not two
 * different controls (UI-SPEC "Component Inventory" row).
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
        position: "absolute",
        top: 8,
        left: 8,
        zIndex: 5,
        width: 28,
        height: 28,
        padding: 4,
        background: hovering
          ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
          : "transparent",
        border: "none",
        borderRadius: 4,
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
