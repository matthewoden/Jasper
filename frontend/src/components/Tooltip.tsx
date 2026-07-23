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
  // UAT round 2 (caret-connection fix): a hard 1px border here would draw a
  // line straight across the base of the Arrow (Radix renders the arrow
  // OUTSIDE the Content's border box), making the caret look severed from
  // the body. Dropping the border and defining the tooltip edge with
  // box-shadow alone means there is no border line to intersect — the arrow
  // (same solid fill, no border/shadow of its own) reads as one continuous
  // shape with the body in both light and dark. The shadow is deliberately
  // a bit stronger than the old `0 4px 12px rgba(0,0,0,0.10)` plus a tight
  // near-0-blur pass, so the surface still reads as a distinct floating
  // panel without a hairline border.
  borderRadius: 6,
  padding: "4px 8px",
  boxShadow:
    "0 0 0 1px rgba(0, 0, 0, 0.30), 0 4px 16px rgba(0, 0, 0, 0.35)",
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
  // Solid fill matching the body, no border/drop-shadow of its own — the
  // caret is a flush extension of the Content surface, not a separately
  // outlined shape (UAT round 2: caret was reading as dim/detached).
  fill: "var(--color-surface)",
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
