


import type { CSSProperties } from "react";

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 20,
  height: 20,
  padding: "0 6px",
  borderRadius: 4,
  border: "1px solid color-mix(in srgb, var(--color-muted) 30%, transparent)",
  background: "color-mix(in srgb, var(--color-muted) 8%, transparent)",
  fontFamily:
    '-apple-system, "SF Pro Display", BlinkMacSystemFont, var(--font-mono), "SF Mono", Menlo, monospace',
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-muted)",
  lineHeight: 1,
  whiteSpace: "nowrap",
};

interface KeyboardChipProps {
  children: string;
}

export function KeyboardChip({ children }: KeyboardChipProps) {
  return <kbd style={chipStyle}>{children}</kbd>;
}
