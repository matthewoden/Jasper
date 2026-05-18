/**
 * McpGrantIndicator — Sparkles icon + optional Tier-2 corner badge.
 *
 * Phase 8 Plan 08-10 (UI-SPEC §Surface 3, D-19, MCP-02).
 *
 * Renders on folder rows that carry a DIRECT MCP write grant (the grant
 * was attached to THIS folder, not inherited from an ancestor). Per
 * UI-SPEC §Surface 3 the indicator NEVER renders on descendant rows —
 * `directLevelFor` (not `levelFor`) drives the conditional (T-08-48
 * Confused Deputy mitigation).
 *
 * Visual contract (LOCKED):
 *   - 16×16 outer wrapper, inline-flex centered.
 *   - Sparkles icon (lucide-react), 16px, strokeWidth=2, stroke color
 *     `var(--color-ai-grant)` (Tier-1 default; Tier-2 keeps the same
 *     stroke because the upgrade is conveyed by the badge dot, not by
 *     re-coloring the icon).
 *   - Tier-2 badge: 6px outer circle (4px filled dot + 1px halo) at the
 *     bottom-right corner of the wrapper. Fill `--color-ai-grant-strong`,
 *     border `1px solid var(--color-surface)` (the halo so the dot stays
 *     legible against the row hover background).
 *
 * Selector contract (LOCKED — per revision Blocker 2 / 08-15 Playwright):
 *   The outer wrapper MUST carry BOTH:
 *     - data-testid="mcp-grant-indicator"
 *     - data-grant-tier={level}        (renders as "1" or "2")
 *   Both attributes ship — 08-15's tests use each independently:
 *     - page.getByTestId('mcp-grant-indicator') → locate
 *     - page.locator('[data-grant-tier="1"]')   → distinguish tier
 *
 * Accessibility: native `title` + `aria-label` carry the human-readable
 * tier ("AI access: Edit only" / "AI access: Full"). Screen readers
 * announce the role of the icon without needing a separate text span.
 */
import { Sparkles } from "lucide-react";
import type { CSSProperties } from "react";

export interface McpGrantIndicatorProps {
  level: 1 | 2;
}

const wrapperStyle: CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 16,
  height: 16,
  flexShrink: 0,
};

const badgeStyle: CSSProperties = {
  position: "absolute",
  bottom: -1,
  right: -1,
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--color-ai-grant-strong)",
  border: "1px solid var(--color-surface)",
  boxSizing: "border-box",
};

export function McpGrantIndicator({ level }: McpGrantIndicatorProps) {
  const tooltip = level === 2 ? "AI access: Full" : "AI access: Edit only";
  return (
    <span
      data-testid="mcp-grant-indicator"
      data-grant-tier={level}
      title={tooltip}
      aria-label={tooltip}
      style={wrapperStyle}
    >
      <Sparkles
        size={16}
        strokeWidth={2}
        color="var(--color-ai-grant)"
        aria-hidden="true"
      />
      {level === 2 && <span aria-hidden="true" style={badgeStyle} />}
    </span>
  );
}
