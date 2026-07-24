/**
 * editorChromeResponsive — pure width-driven layout decisions for the
 * editor's top-chrome bar (breadcrumb + right-pinned favorite star / note-
 * options menu, Phase 31 UAT rounds 2-3).
 *
 * Mirrors the tabOverflow.ts pattern: visibility/max-width is arithmetic over
 * measured widths, deterministically testable without ResizeObserver or
 * layout timing. EditorPane only feeds these functions a measured
 * `clientWidth`; everything else is pure.
 *
 * UAT round 3 (#3/#6): word count moved out of this cluster entirely (now
 * lives in the bottom StatusBar, focused-note aware) — the right cluster is
 * just [favorite, ⋯], so there is no more word-count breakpoint here.
 */

/** Below this bar width, the favorite star hides — only ⋯ remains (⋯ is never hidden). */
export const STAR_HIDE_WIDTH = 380;

export interface ChromeVisibility {
  showStar: boolean;
}

/**
 * Decide whether the favorite star shows at the given bar width (⋯ always
 * shows — it is never gated by this function).
 *
 * barWidth <= 0 (jsdom / pre-layout escape hatch, same convention as
 * tabOverflow's computeHiddenTabIds) shows the star rather than over-hiding
 * against a zero/negative measurement.
 */
export function computeChromeVisibility(barWidth: number): ChromeVisibility {
  if (barWidth <= 0) {
    return { showStar: true };
  }
  return {
    showStar: barWidth >= STAR_HIDE_WIDTH,
  };
}

export interface BreadcrumbMaxWidthInput {
  /** Measured width of the top-chrome bar (the full-width row). */
  barWidth: number;
  /** Measured width of the right-pinned cluster (favorite + ⋯, whichever are visible). */
  clusterWidth: number;
  /** Breathing room between the centered breadcrumb and the cluster. */
  gap?: number;
}

/**
 * Maximum width (px) the FULLY-CENTERED breadcrumb content may occupy
 * without colliding with the right-pinned cluster (UAT round 3 #4 — the
 * breadcrumb centers in the bar's full width, not a fixed 760px column).
 *
 * Only the right side is physically obstructed by the cluster, but capping
 * symmetrically (`barWidth - 2*(clusterWidth+gap)`) keeps the breadcrumb's
 * OWN centering intact: as long as its content fits inside this cap, its
 * center coincides with the bar's center and neither edge reaches the
 * cluster. Content wider than the cap falls back to the existing
 * per-segment ellipsis truncation (folder segments give way first, the
 * title segment truncates only as a last resort).
 *
 * barWidth <= 0 (jsdom / pre-layout escape hatch) returns undefined — "no
 * cap" — matching the same convention as computeChromeVisibility.
 */
export function computeBreadcrumbMaxWidth({
  barWidth,
  clusterWidth,
  gap = 8,
}: BreadcrumbMaxWidthInput): number | undefined {
  if (barWidth <= 0) return undefined;
  return Math.max(0, barWidth - 2 * (clusterWidth + gap));
}
