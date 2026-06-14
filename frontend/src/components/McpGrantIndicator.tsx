/**
 * McpGrantIndicator — Sparkles icon + optional Tier-2 corner badge.
 *
 * Renders only on folder rows that carry a DIRECT MCP write grant (not inherited
 * from an ancestor). The outer wrapper carries data-testid="mcp-grant-indicator"
 * and data-grant-tier={level} so E2E tests can locate and distinguish tiers.
 * title + aria-label carry the human-readable tier string.
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
