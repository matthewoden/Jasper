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
 * Glyph is CENTERED in the 40px-wide cell (mirrors the mock's `leftToggle`
 * cell — `Vault.dc.html` line ~795 — which centers its icon inside a
 * full-height 40px-wide button, not left-aligned with an inset). Hover is a
 * compact 32x32 rounded-square tint around the glyph, mirroring
 * ActivityRibbon's own `RibbonButton` (32x32, borderRadius 6) rather than a
 * full-height 40px rectangle — so the affordance reads as a continuation of
 * the ribbon's own icon column instead of an oversized left-offset glyph
 * (Phase 27 follow-up fix round, item 2).
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
          width: 32,
          height: 32,
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
