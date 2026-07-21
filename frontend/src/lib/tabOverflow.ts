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
/**
 * Natural cap a pill grows to. Reconciled to 185 for the Phase 18 flush-tab
 * restyle: the title span (flex:1) ellipsizes at roughly
 * (pill width - file icon 14 - gaps 8 - horizontal padding 16 - close X 20)
 * chrome, so 185 - ~58 = ~127px title width, matching DESIGN-NOTES.md §3's
 * "~130px" target. Stays above MIN_TAB_WIDTH (120) so no inversion.
 */
export const MAX_TAB_WIDTH = 185;

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

export interface DropIndexInput {
  /** Full tab order (including hidden/overflowed tabs). */
  tabIds: string[];
  /** Currently visible tab order (a subset of tabIds, same relative order). */
  visibleTabIds: string[];
  /** The visible tab the pointer is dropping onto, or null to drop past the last visible tab. */
  targetId: string | null;
}

/**
 * Map a drop onto the VISIBLE tab strip to a full-array insert index (WR-03).
 *
 * Hidden (overflowed) tabs can be interleaved between visible ones, so the
 * naive `tabIds.findIndex(t => t.id === targetId)` spans those hidden tabs
 * and diverges from where the drop indicator promised the tab would land.
 * Instead, anchor on the VISIBLE tab immediately before the target: the
 * insert index is that tab's full-array position + 1 (or 0 if the target is
 * the first visible tab / there is no previous visible tab).
 */
export function computeDropIndex(input: DropIndexInput): number {
  const { tabIds, visibleTabIds, targetId } = input;

  let prevVisibleId: string | undefined;
  if (targetId === null) {
    // Past the last visible tab — land immediately after it.
    prevVisibleId = visibleTabIds[visibleTabIds.length - 1];
  } else {
    const visIdx = visibleTabIds.findIndex((id) => id === targetId);
    if (visIdx === -1) return -1;
    prevVisibleId = visibleTabIds[visIdx - 1];
  }

  if (prevVisibleId === undefined) return 0;
  const prevFullIdx = tabIds.findIndex((id) => id === prevVisibleId);
  return prevFullIdx === -1 ? 0 : prevFullIdx + 1;
}

/**
 * clampIndexToPinnedBoundary — enforces the pinned/unpinned region boundary
 * (D-15/D-16) on any computed insertion index (drag drop-index, foreign-strip
 * insert, or "New note to the right"). `pinnedCount` is the number of OTHER
 * pinned tabs already in the TARGET leaf — i.e. NOT counting the tab being
 * moved, whether or not it is currently a member of that leaf. Under that
 * convention the boundary is symmetric: a pinned mover must land at or before
 * the boundary (`<= pinnedCount`, becoming the newest last-pinned tab), and
 * an unpinned mover must land at or after it (`>= pinnedCount`) — an unpinned
 * tab can never land inside the pinned region, and a pinned tab can never
 * land outside it. A sentinel `-1` (no valid drop target) passes through
 * unchanged — clamping only applies to a real index.
 */
export function clampIndexToPinnedBoundary(
  index: number,
  pinnedCount: number,
  draggedIsPinned: boolean,
): number {
  if (index === -1) return index;
  if (draggedIsPinned) {
    return Math.min(index, pinnedCount);
  }
  return Math.max(index, pinnedCount);
}
