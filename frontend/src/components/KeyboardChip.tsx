// KeyboardChip.tsx — shared <kbd> chip per UI-SPEC §Surface 6 §kbd chip styling.
// Single source of truth (UI-SPEC §Forward-Compat #2). Used by CommandMenu rows
// (Plan 07-11) and KeyboardShortcutsDialog rows (Plan 07-12).
//
// Multi-key shortcuts render as ONE chip with the full glyph sequence.
// Example: <KeyboardChip>⌘⇧D</KeyboardChip> renders one chip displaying "⌘⇧D".
//
// All colors via var(--color-*) tokens (theme-aware; no hex literals).
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
  // UAT #7 fix: lead with -apple-system + SF Pro so macOS browsers render
  // ⌘ ⇧ ⌃ at parity with adjacent letter glyphs. var(--font-mono) stays in
  // the stack as the cross-platform monospace fallback.
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
