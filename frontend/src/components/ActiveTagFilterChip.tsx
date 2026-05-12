/**
 * ActiveTagFilterChip — UI-SPEC §Surface 7 (Phase 6.6).
 *
 * Renders only when activeTagFilter is non-null. When active, shows a
 * full-width chip with "Filtered by: #tagname ×" structure:
 *   - "Filtered by:" prefix in --color-muted
 *   - "#tagname" in --color-accent, fontWeight 600, truncated with ellipsis
 *   - × dismiss button at right edge, --color-fg normal / --color-accent hover
 *
 * Placement: pinned to the top of the notes-panel content area (above the
 * file tree or flat list). Width 100% fills the content area.
 *
 * Implements D-23, D-24, D-25, D-26.
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import { X } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";

const chipStyle: CSSProperties = {
  width: "100%",
  height: 24,
  padding: "0 8px",
  margin: "8px 0",
  background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)",
  borderRadius: 4,
  display: "flex",
  alignItems: "center",
  flexShrink: 0,
  boxSizing: "border-box",
  overflow: "hidden",
};

const prefixStyle: CSSProperties = {
  color: "var(--color-muted)",
  fontSize: 14,
  fontWeight: 400,
  flexShrink: 0,
  marginRight: 4,
};

const tagStyle: CSSProperties = {
  color: "var(--color-accent)",
  fontSize: 14,
  fontWeight: 600,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0,
};

const dismissBase: CSSProperties = {
  marginLeft: "auto",
  padding: 0,
  background: "none",
  border: "none",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

export function ActiveTagFilterChip(): JSX.Element | null {
  const activeTagFilter = useTreeStore((s) => s.activeTagFilter);
  const setActiveTagFilter = useTreeStore((s) => s.setActiveTagFilter);
  const [hovering, setHovering] = useState(false);

  if (!activeTagFilter) return null;

  return (
    <div
      style={chipStyle}
      role="status"
      aria-label={`Active filter: #${activeTagFilter}`}
    >
      <span style={prefixStyle}>Filtered by:</span>
      <span style={tagStyle}>#{activeTagFilter}</span>
      <button
        type="button"
        aria-label={`Remove tag filter: #${activeTagFilter}`}
        onClick={() => setActiveTagFilter(null)}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        style={{
          ...dismissBase,
          color: hovering ? "var(--color-accent)" : "var(--color-fg)",
        }}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}
