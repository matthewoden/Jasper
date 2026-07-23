/**
 * Shared app-wide tooltip system (D-06..D-09, Phase 31).
 *
 * One shared token-styled Tooltip wrapper + a single app-root
 * TooltipProvider. delayDuration/skipDelayDuration give the Obsidian-style
 * "short delay first, instant re-show while scanning adjacent controls"
 * behavior via Radix's own built-in semantics — no custom timer logic.
 */
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { CSSProperties, ReactNode } from "react";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={400} skipDelayDuration={300}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

const contentStyle: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: "4px 8px",
  // Matches .cm-tooltip-autocomplete (theme.css) — the project's established
  // popup shadow convention.
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.10)",
  fontSize: 12,
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  zIndex: 50,
};

const labelStyle: CSSProperties = {
  color: "var(--color-fg)",
  fontWeight: 500,
};

const shortcutStyle: CSSProperties = {
  color: "var(--color-muted)",
  fontWeight: 400,
};

export interface TooltipProps {
  label: string;
  /** Rendered muted after the label, e.g. "⌘O" (D-08). */
  shortcut?: string;
  side?: "top" | "right" | "bottom" | "left";
  /** The trigger element (an icon button), wrapped via Trigger asChild. */
  children: ReactNode;
}

export function Tooltip({ label, shortcut, side = "bottom", children }: TooltipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content style={contentStyle} side={side} sideOffset={4}>
          <span style={labelStyle}>{label}</span>
          {shortcut && <span style={shortcutStyle}>{shortcut}</span>}
          <TooltipPrimitive.Arrow style={{ fill: "var(--color-surface)" }} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
