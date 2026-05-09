/**
 * Phase 5.5 — Plan 05 (UX-09): SidebarResizeHandle.
 *
 * 4px-wide pointer-events drag handle anchored to the sidebar's right edge.
 * Drives `useTreeStore.setSidebarWidth` on `pointermove`; the store clamps
 * to SIDEBAR_WIDTH_DEFAULT (MIN) and the existing 250ms-debounced subscriber
 * persists the width to localStorage.
 *
 * Recipe (RESEARCH §Pattern 5):
 *   - `pointerdown` on the handle → mark `draggingRef.current = true` and
 *     attach `pointermove` + `pointerup` listeners to `document` so the drag
 *     keeps tracking even when the cursor leaves the 4px hit area.
 *   - `pointermove` → compute the new width as `clamp(MIN, clientX, MAX)`
 *     where MAX = `max(MIN, window.innerWidth - 320)` (keeps the editor
 *     pane ≥320px wide).
 *   - `pointerup` → flip `draggingRef` off and detach BOTH document
 *     listeners. Cleanup is explicit so a long-lived process never leaks.
 *
 * Anti-patterns the recipe rejects:
 *   - No visible 1px divider line (Open Question 4 in RESEARCH — cursor
 *     change on the 4px hit area is the entire UX cue).
 *   - No `react-resizable-panels` import (project bias: no extras; the
 *     ~30-line raw recipe matches the rest of the codebase).
 *   - `e.preventDefault()` is REQUIRED on pointerdown — without it, the
 *     browser starts a native text-selection drag on the sidebar.
 *
 * Accessibility: role="separator" + aria-orientation="vertical" +
 * aria-label="Resize sidebar" matches the WAI-ARIA window-splitter
 * convention. (Phase 5.5 v1 ships pointer-driven only; keyboard arrow-key
 * resize is deferred.)
 */
import { useCallback, useRef } from "react";
import type React from "react";

import {
  useTreeStore,
  SIDEBAR_WIDTH_DEFAULT,
} from "../lib/useTreeStore";

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
const EDITOR_MIN = 320;
const computeMaxWidth = (): number => {
  const room = window.innerWidth - EDITOR_MIN;
  if (room < SIDEBAR_WIDTH_MIN) {
    // Viewport too narrow for both floors — preserve the editor floor
    // by giving the sidebar only the leftover room (or 0 on degenerate
    // sub-EDITOR_MIN viewports).
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

export function SidebarResizeHandle() {
  const setSidebarWidth = useTreeStore((s) => s.setSidebarWidth);
  const draggingRef = useRef(false);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return;
      // BL-03 (Phase 5.5 gap-closure Plan 11): max is computed against the
      // LIVE viewport every pointermove so a window-resize-narrower
      // mid-drag immediately reflects the tighter bound. The lower clamp
      // at SIDEBAR_WIDTH_MIN is preserved; on a narrow viewport this
      // collapses newWidth to the live max (since `min(small_max, MIN+) =
      // small_max`), which is the correct degraded-but-usable behavior.
      const newWidth = Math.min(
        computeMaxWidth(),
        Math.max(SIDEBAR_WIDTH_MIN, e.clientX),
      );
      setSidebarWidth(newWidth);
    },
    [setSidebarWidth],
  );

  const onPointerUp = useCallback(() => {
    draggingRef.current = false;
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
  }, [onPointerMove]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault(); // prevent native text-selection drag
      draggingRef.current = true;
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    },
    [onPointerMove, onPointerUp],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      data-testid="sidebar-resize-handle"
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 4,
        cursor: "col-resize",
        userSelect: "none",
      }}
    />
  );
}
