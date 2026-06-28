/**
 * tabOverflow — the pure "shrink-then-dropdown" overflow decision (TAB-16/17).
 *
 * Tabs shrink to a uniform minimum width to show as many ellipsized titles as
 * the strip allows; whatever still doesn't fit collapses into the overflow
 * dropdown. The hidden-tab decision is a PURE function over widths + counts so
 * it is deterministically testable without ResizeObserver or layout timing.
 * TabStrip only feeds it a measured `clientWidth`; everything else is arithmetic.
 */

/** Floor each pill shrinks to before tabs start collapsing into the dropdown. */
export const MIN_TAB_WIDTH = 120;
/** Natural cap a pill grows to (matches the prior fixed maxWidth). */
export const MAX_TAB_WIDTH = 200;

export interface OverflowInput {
  tabIds: string[];
  activeTabId: string | null;
  /** Strip content-box width already net of reserved chrome (padding + button). */
  availableWidth: number;
  /** Minimum pill width; = MIN_TAB_WIDTH. */
  minTabWidth: number;
  /** Width reserved for the dropdown trigger — counted ONLY when overflow occurs. */
  overflowButtonWidth: number;
}

/**
 * Decide which tabIds must collapse into the overflow dropdown.
 *
 * Deterministic, no layout:
 *   1. availableWidth <= 0 → empty Set (jsdom / pre-layout escape hatch).
 *   2. If every tab fits at minTabWidth → empty Set.
 *   3. Overflow: reserve the dropdown trigger; keep the first `visibleCount`
 *      tabs. If the active tab falls outside that window, evict the last kept
 *      tab to keep the active one visible (active is never hidden).
 *   4. Everything not kept is hidden.
 */
export function computeHiddenTabIds(input: OverflowInput): Set<string> {
  const { tabIds, activeTabId, availableWidth, minTabWidth, overflowButtonWidth } =
    input;

  if (availableWidth <= 0) return new Set();

  const fitAll = Math.floor(availableWidth / minTabWidth);
  if (tabIds.length <= fitAll) return new Set();

  const visibleCount = Math.max(
    1,
    Math.floor((availableWidth - overflowButtonWidth) / minTabWidth),
  );

  const kept = new Set(tabIds.slice(0, visibleCount));

  // Active is never hidden: if it fell outside the window, swap it in for the
  // last otherwise-kept tab (preserves visibleCount; active stays on the strip).
  if (activeTabId !== null && tabIds.includes(activeTabId) && !kept.has(activeTabId)) {
    const lastKept = tabIds.slice(0, visibleCount)[visibleCount - 1];
    if (lastKept !== undefined) kept.delete(lastKept);
    kept.add(activeTabId);
  }

  return new Set(tabIds.filter((id) => !kept.has(id)));
}
