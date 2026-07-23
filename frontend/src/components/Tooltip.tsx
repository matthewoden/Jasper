/**
 * Shared app-wide tooltip system (D-06..D-09, Phase 31; UAT gap-closure
 * group A).
 *
 * One shared token-styled Tooltip wrapper + a single app-root
 * TooltipProvider. delayDuration/skipDelayDuration give the Obsidian-style
 * "short delay first, instant re-show while scanning adjacent controls"
 * behavior via Radix's own built-in semantics — no custom timer logic.
 *
 * Default placement is `side="bottom"` everywhere (owner UAT: "tooltips
 * below the icon"); the far-left ActivityRibbon is the sole exception
 * (`side="right"`, since below would collide with the next ribbon icon).
 * `disableHoverableContent` + `pointerEvents: "none"` keep the tooltip a
 * pure hint — it dismisses the moment the pointer leaves the trigger and
 * never intercepts a click meant for the control underneath it. The
 * optional `content` prop is a rich-content escape hatch for callers that
 * need more than a label + shortcut (e.g. note-row date tooltips).
 */
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { CSSProperties, ReactNode } from "react";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={400}
      skipDelayDuration={300}
      // UAT gap-closure (group A): moving the pointer off the trigger and
      // onto the floating tooltip must dismiss it immediately, not keep it
      // open — the tooltip is a hint, never an interactive surface.
      disableHoverableContent
    >
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
  // UAT gap-closure (group A): the tooltip must never intercept clicks meant
  // for the control (or anything else) beneath it.
  pointerEvents: "none",
};

const arrowStyle: CSSProperties = {
  fill: "var(--color-surface)",
  // The Arrow can't inherit the Content's border, so a subtle drop-shadow
  // along its lower silhouette keeps it defined against the surface color
  // it shares (UAT gap-closure: caret was reading as invisible).
  filter: "drop-shadow(0 1px 0 var(--color-border))",
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
  /** Required unless `content` is given, which fully replaces the label+shortcut rendering. */
  label?: string;
  /** Rendered muted after the label, e.g. "⌘O" (D-08). Ignored when `content` is given. */
  shortcut?: string;
  /**
   * Rich-content escape hatch (needed by note-row dates, group B): when
   * provided, renders in place of the label+shortcut spans. `label` becomes
   * optional in this mode.
   */
  content?: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** The trigger element (an icon button), wrapped via Trigger asChild. */
  children: ReactNode;
}

export function Tooltip({ label, shortcut, content, side = "bottom", children }: TooltipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content style={contentStyle} side={side} sideOffset={4}>
          {content ?? (
            <>
              <span style={labelStyle}>{label}</span>
              {shortcut && <span style={shortcutStyle}>{shortcut}</span>}
            </>
          )}
          <TooltipPrimitive.Arrow width={10} height={5} style={arrowStyle} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
