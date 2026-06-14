/**
 * SidebarResizeHandle — 8px transparent hit-area at the sidebar's right edge.
 * Cursor change (col-resize) is the only visual cue.
 *
 * Drag lifecycle:
 *   - pointerdown → mark draggingRef, attach pointermove + pointerup to document
 *     (listeners stay active even when cursor leaves the 8px hit area)
 *   - pointermove → clamp(MIN, clientX, MAX) where MAX = computeMaxWidth()
 *     (keeps editor pane ≥320px)
 *   - pointerup → clear draggingRef, detach both listeners
 *
 * e.preventDefault() on pointerdown is required — without it, the browser
 * starts a native text-selection drag on the sidebar content.
 */
import { useCallback, useRef } from "react";
import type React from "react";

import { useTreeStore, SIDEBAR_WIDTH_DEFAULT } from "../lib/useTreeStore";

import { computeMaxWidth } from "./sidebarResizeHandle.utils";

const SIDEBAR_WIDTH_MIN = SIDEBAR_WIDTH_DEFAULT;


export function SidebarResizeHandle() {
  const setSidebarWidth = useTreeStore((s) => s.setSidebarWidth);
  const draggingRef = useRef(false);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return;
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
      e.preventDefault();
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
        width: 8, // 8px hit area; transparent, cursor-only affordance
        cursor: "col-resize",
        userSelect: "none",
      }}
    />
  );
}
