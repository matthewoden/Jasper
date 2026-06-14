/**
 * Sidebar resize handle helpers — extracted from SidebarResizeHandle.tsx
 * so the component file only exports React components, satisfying the
 * react-refresh/only-export-components ESLint rule.
 */
import { SIDEBAR_WIDTH_DEFAULT } from "../lib/useTreeStore";

const SIDEBAR_WIDTH_MIN = SIDEBAR_WIDTH_DEFAULT;

/**
 * Editor pane needs at least 320px to remain usable.
 *
 * On narrow viewports where both MIN floors can't be satisfied simultaneously,
 * give the editor whatever's left (innerWidth - EDITOR_MIN, floored at 0).
 * The sidebar may shrink below its preferred MIN — acceptable degradation on
 * very small viewports.
 *
 * Computed dynamically so mid-drag window resizes take effect immediately.
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
