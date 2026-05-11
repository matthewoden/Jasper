/**
 * ActiveTagFilterChip — UI-SPEC §Surface 1 > Active Tag Filter Chip.
 *
 * Renders only when activeTagFilter is non-null (C1). When active, shows
 * the tag name and a × button to clear the filter (C2, C3).
 *
 * Placement: pinned to the top of the file tree scroll area (inside
 * FileTree's scroll container, above the first tree row or flat list).
 *
 * Styles (verbatim from UI-SPEC Surface 1):
 *   height: 24px, margin: 8px 16px
 *   background: color-mix(in srgb, var(--color-accent) 12%, transparent)
 *   border: 1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)
 *   border-radius: 4px
 *   tag name: 12px / weight 600 / --color-accent
 *   × icon: Lucide X at 12px, --color-accent
 */
import { X } from "lucide-react";
import type { CSSProperties } from "react";
import { useTreeStore } from "../lib/useTreeStore";

const chipStyle: CSSProperties = {
  margin: "8px 16px",
  height: 24,
  padding: "0 8px",
  background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)",
  borderRadius: 4,
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexShrink: 0,
};

const tagNameStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-accent)",
};

const closeBtnStyle: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--color-accent)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  padding: 0,
};

export function ActiveTagFilterChip() {
  const tag = useTreeStore((s) => s.activeTagFilter);
  const setFilter = useTreeStore((s) => s.setActiveTagFilter);

  if (!tag) return null;

  return (
    <div style={chipStyle}>
      <span style={tagNameStyle}>{tag}</span>
      <button
        type="button"
        onClick={() => setFilter(null)}
        aria-label={`Remove tag filter: ${tag}`}
        style={closeBtnStyle}
      >
        <X size={12} />
      </button>
    </div>
  );
}
