/**
 * editorChromeResponsive — pure width-driven layout decisions for the
 * editor's top-chrome bar (breadcrumb + right-pinned word count / favorite
 * star / note-options menu, Phase 31 UAT round 2).
 *
 * Mirrors the tabOverflow.ts pattern: visibility/reserve is arithmetic over
 * measured widths, deterministically testable without ResizeObserver or
 * layout timing. EditorPane only feeds these functions a measured
 * `clientWidth`; everything else is pure.
 */

/** Below this bar width, the word count hides first (star + ⋯ still show). */
export const WORD_COUNT_HIDE_WIDTH = 480;
/** Below this bar width, the favorite star ALSO hides — only ⋯ remains (⋯ is never hidden). */
export const STAR_HIDE_WIDTH = 380;

export interface ChromeVisibility {
  showWordCount: boolean;
  showStar: boolean;
}

/**
 * Decide which right-cluster items show at the given bar width.
 *
 * barWidth <= 0 (jsdom / pre-layout escape hatch, same convention as
 * tabOverflow's computeHiddenTabIds) shows everything rather than
 * over-hiding against a zero/negative measurement.
 */
export function computeChromeVisibility(barWidth: number): ChromeVisibility {
  if (barWidth <= 0) {
    return { showWordCount: true, showStar: true };
  }
  return {
    showWordCount: barWidth >= WORD_COUNT_HIDE_WIDTH,
    showStar: barWidth >= STAR_HIDE_WIDTH,
  };
}

export interface BreadcrumbReserveInput {
  /** Measured width of the top-chrome bar (the full-width row). */
  barWidth: number;
  /** Measured width of the right-pinned cluster (word count + star + ⋯, whichever are visible). */
  clusterWidth: number;
  /** The breadcrumb's own centered reading column cap (matches the title/body column, D-12). */
  columnMaxWidth?: number;
  /** Breathing room between the title's last character and the cluster. */
  gap?: number;
}

/**
 * Extra right-padding (px) the breadcrumb's segment row must reserve so its
 * content never renders under the absolutely-positioned right cluster.
 *
 * The breadcrumb nav is centered at `columnMaxWidth` (760) via its own
 * maxWidth+margin:auto (unchanged, body-column alignment) — once the bar is
 * wider than that column, there is already a natural gap on each side before
 * the true bar edge (where the cluster is pinned), and no extra reserve is
 * needed. Once the bar narrows to (or below) the column width, that natural
 * gap collapses to zero and the column's own content would otherwise run
 * straight under the cluster — the reserve exactly closes that gap.
 */
export function computeBreadcrumbReserve({
  barWidth,
  clusterWidth,
  columnMaxWidth = 760,
  gap = 8,
}: BreadcrumbReserveInput): number {
  if (barWidth <= 0) return 0;
  const naturalGap = barWidth > columnMaxWidth ? (barWidth - columnMaxWidth) / 2 : 0;
  return Math.max(0, clusterWidth + gap - naturalGap);
}
