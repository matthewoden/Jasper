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
  // UAT round 3 (bordered-caret fix): the border is back on the body (owner
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
  // UAT gap-closure (group A): the tooltip must never intercept clicks meant
  // for the control (or anything else) beneath it.
  pointerEvents: "none",
};

// UAT round 3 (bordered-caret fix): Radix's Arrow renders a single SVG
// <polygon> (viewBox "0 0 30 10", non-uniform x/y scale via
// preserveAspectRatio="none") flush against the Content edge it's anchored
// to — the polygon's flat edge touches/overlaps the Content border exactly,
// and its two slanted edges + apex are the visible "caret" poking out past
// it. `fill`/`stroke`/`strokeWidth` are inheritable SVG presentation
// properties, so setting them on the outer <svg> (this style prop) cascades
// onto Radix's default polygon without needing a custom `asChild` shape.
// `vectorEffect: "non-scaling-stroke"` is the key trick: it makes
// strokeWidth resolve in real screen pixels rather than the 30x10 viewBox's
// local units (which would otherwise render a near-invisible sliver once
// scaled down to the 10x5 rendered box) — so this reliably draws a true 1px
// line, matching the Content border's own 1px weight exactly. The polygon's
// flat (hidden/overlapped) edge gets stroked too, but since it sits flush
// against the Content border at the same color/width, it simply merges into
// the seam rather than doubling it. `overflow: visible` on the <svg> stops
// the UA default (`overflow: hidden` on root <svg>) from clipping the
// outward half of the centered stroke. Same rule works unmodified for both
// side="bottom" (most controls) and side="right" (ribbon) since it's driven
// by Radix's own per-side Arrow rotation, not any bespoke per-side math.
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
