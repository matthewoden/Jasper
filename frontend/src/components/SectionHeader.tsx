/**
 * SectionHeader — unified, whole-row-clickable collapse header shared by the
 * right rail's Outline / Linked mentions / Tags sections (Phase 20, D-01/D-03).
 *
 * Entire 32px row is a <button> that toggles collapse — no separate "×" close
 * affordance (D-01 removes the legacy per-panel close button entirely).
 * Chevron uses icon-swap (ChevronDown/ChevronRight), never CSS rotate, matching
 * TreeRow.tsx's folder-fold convention.
 */
import type { CSSProperties } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

const headerStyle: CSSProperties = {
  height: 32,
  padding: "0 12px",
  background: "var(--color-surface)",
  display: "flex",
  alignItems: "center",
  gap: 8,
  border: "none",
  borderBottom: "1px solid var(--color-border)",
  width: "100%",
  cursor: "pointer",
  textAlign: "left",
  flexShrink: 0,
};

const labelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-muted)",
  lineHeight: 1.4,
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** Count-badge pill — reused verbatim from RightRailTagsPanel's tag-count pill. */
const countPillStyle: CSSProperties = {
  padding: "0 6px",
  height: 18,
  minWidth: 18,
  borderRadius: 9,
  background: "color-mix(in srgb, var(--color-fg) 10%, transparent)",
  color: "var(--color-muted)",
  fontSize: 11,
  fontWeight: 600,
  lineHeight: "18px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

export interface SectionHeaderProps {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  /** Omitted entirely when undefined — e.g. Outline has no count badge. */
  count?: number;
  ariaCollapsedLabel: string;
  ariaExpandedLabel: string;
}

export function SectionHeader({
  title,
  expanded,
  onToggle,
  count,
  ariaCollapsedLabel,
  ariaExpandedLabel,
}: SectionHeaderProps) {
  return (
    <button
      type="button"
      style={headerStyle}
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={expanded ? ariaExpandedLabel : ariaCollapsedLabel}
    >
      {expanded ? (
        <ChevronDown
          size={16}
          style={{ color: "var(--color-muted)", flexShrink: 0 }}
          aria-hidden="true"
        />
      ) : (
        <ChevronRight
          size={16}
          style={{ color: "var(--color-muted)", flexShrink: 0 }}
          aria-hidden="true"
        />
      )}
      <span style={labelStyle}>{title}</span>
      {count !== undefined && <span style={countPillStyle}>{count}</span>}
    </button>
  );
}
