/**
 * Phase 5.5 — Plan 05 (UX-09) sidebar-resize-handle helpers.
 *
 * Extracted from SidebarResizeHandle.tsx so the component file
 * only exports React components — satisfies the
 * react-refresh/only-export-components ESLint rule and restores
 * Fast Refresh for the resize handle UI.
 */
import { SIDEBAR_WIDTH_DEFAULT } from "../lib/useTreeStore";

const SIDEBAR_WIDTH_MIN = SIDEBAR_WIDTH_DEFAULT;

/**
 * Editor pane needs at least 320px to remain usable.
 *
 * BL-03 (Phase 5.5 gap-closure Plan 11) — narrow-viewport fix. Previously
 * `Math.max(SIDEBAR_WIDTH_MIN, innerWidth - 320)` floored to MIN whenever
 * the viewport was too narrow for both floors, which let the sidebar
 * consume editor pane area. The replacement: when the viewport can't
 * satisfy both floors, give the editor pane whatever's left
 * (`innerWidth - EDITOR_MIN`, floored at 0). The sidebar may end up
 * narrower than its preferred MIN on tiny viewports — acceptable
 * degradation for the unsupported-but-not-broken case.
 *
 * Computed dynamically so a window-resize between drags (or even
 * mid-drag) reflects the new viewport's max.
 */
export const EDITOR_MIN = 320;

export const computeMaxWidth = (): number => {
  const room = window.innerWidth - EDITOR_MIN;
  if (room < SIDEBAR_WIDTH_MIN) {
    return Math.max(0, room);
  }
  return room;
};

/**
 * Internal-only export for unit tests. Lets tests reach `computeMaxWidth`
 * and the `EDITOR_MIN` constant directly without going through the React
 * component shell. Public consumers should NOT depend on this; the shape
 * is allowed to change without a major bump.
 */
export const __testing__ = { computeMaxWidth, EDITOR_MIN };
