/**
 * editorChromeResponsive — pure width arithmetic for the editor's top chrome,
 * so layout decisions are testable without ResizeObserver or timing. EditorPane
 * feeds in a measured clientWidth; everything here is pure.
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
 * Max width the centered breadcrumb may occupy without colliding with the
 * right-pinned cluster.
 *
 * Only the right side is obstructed, but the cap is SYMMETRIC on purpose: that
 * is what keeps the breadcrumb's own centering intact, so its center stays the
 * bar's center and neither edge reaches the cluster. Wider content falls back to
 * per-segment ellipsis.
 *
 * barWidth <= 0 returns undefined ("no cap"), matching computeChromeVisibility.
 */
export function computeBreadcrumbMaxWidth({
  barWidth,
  clusterWidth,
  gap = 8,
}: BreadcrumbMaxWidthInput): number | undefined {
  if (barWidth <= 0) return undefined;
  return Math.max(0, barWidth - 2 * (clusterWidth + gap));
}
