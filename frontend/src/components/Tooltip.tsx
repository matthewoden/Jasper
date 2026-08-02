/**
 * Shared tooltip: one styled wrapper plus a single app-root TooltipProvider.
 * The delay/skip-delay pair gives Obsidian's "short delay first, instant
 * re-show while scanning" behavior through Radix's own semantics, with no
 * custom timers.
 *
 * Default side is bottom; ActivityRibbon is the sole exception (right), since
 * below would collide with the next ribbon icon.
 *
 * disableHoverableContent + pointerEvents:none keep it a pure hint that never
 * intercepts a click meant for the control underneath.
 */
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { CSSProperties, ReactNode } from "react";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={400}
      skipDelayDuration={300}
      // moving the pointer off the trigger and
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
  // (bordered-caret fix): the border is back on the body (owner
  // feedback — round 2's borderless-body-plus-solid-caret combo read as an
  // outline-less blob). The caret now carries the SAME 1px border on its
  // own outer edges (see arrowStyle below) so the two pieces read as one
  // continuous outlined shape rather than a border abruptly stopping at the
  // Arrow's seam.
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: "4px 8px",
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35)",
  fontSize: 12,
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  zIndex: 50,
  // the tooltip must never intercept clicks meant
  // for the control (or anything else) beneath it.
  pointerEvents: "none",
};

// fill/stroke/strokeWidth are inheritable SVG presentation properties, so
// setting them here cascades onto Radix's default Arrow polygon without needing
// a custom asChild shape.
//
// vectorEffect:"non-scaling-stroke" is the load-bearing bit — it resolves
// strokeWidth in screen pixels rather than the 30x10 viewBox's units, which
// would render a near-invisible sliver once scaled to the 10x5 box.
//
// overflow:visible stops the UA default clipping the outward half of the stroke.
const arrowStyle: CSSProperties = {
  fill: "var(--color-surface)",
  stroke: "var(--color-border)",
  strokeWidth: 1,
  strokeLinejoin: "round",
  vectorEffect: "non-scaling-stroke",
  overflow: "visible",
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
  /** Rendered muted after the label, e.g. "⌘O". Ignored when `content` is given. */
  shortcut?: string;
  /**
   * Rich-content escape hatch (needed by note-row dates): when
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
