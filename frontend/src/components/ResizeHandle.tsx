/**
 * Phase 6.6 — Plan 06.6-01 (UX-CHROME-04): Generic ResizeHandle.
 *
 * D-12: cursor-only affordance — no visible band, transparent background,
 * 8-12px hit area, cursor changes to col-resize (vertical) or row-resize
 * (horizontal) on hover.
 *
 * D-15: generic extraction — single source of truth for drag handle pointer
 * lifecycle. SidebarResizeHandle and InterPanelDivider use this component
 * (InterPanelDivider fully delegates; SidebarResizeHandle keeps its own
 * absolute-clientX clamp math per Pitfall 5 mitigation — see that file).
 *
 * Drag lifecycle (from SidebarResizeHandle.tsx + InterPanelDivider.tsx):
 *   - pointerdown → mark draggingRef.current = true, attach document listeners
 *   - pointermove → compute delta since last position, call onDrag(delta)
 *   - pointerup → flip draggingRef off, detach both document listeners
 *   - useEffect cleanup → guard against listeners surviving a mid-drag unmount
 *
 * Anti-patterns rejected:
 *   - No visible band, no pill, no line (D-12/D-14)
 *   - No hover tint state (D-13 lean: no visual change on hover)
 *   - e.preventDefault() on pointerdown prevents native text-selection drag
 */
import { useCallback, useEffect, useRef } from "react";
import type React from "react";

export interface ResizeHandleProps {
  orientation: "horizontal" | "vertical";
  onDrag: (delta: number) => void;
  "aria-label": string;
  style?: React.CSSProperties;
  /** Optional override for data-testid. Defaults to "resize-handle". */
  "data-testid"?: string;
}

export function ResizeHandle({
  orientation,
  onDrag,
  "aria-label": ariaLabel,
  style,
  "data-testid": testId = "resize-handle",
}: ResizeHandleProps) {
  const draggingRef = useRef(false);
  const lastPosRef = useRef(0);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const currentPos =
        orientation === "vertical" ? (e.clientX ?? 0) : (e.clientY ?? 0);
      const delta = currentPos - lastPosRef.current;
      lastPosRef.current = currentPos;
      onDrag(delta);
    },
    [onDrag, orientation],
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
      // Use nullish coalescing to handle jsdom environments where clientX/Y
      // may be undefined (e.g. in tests using fireEvent.pointerDown without
      // explicit clientX/Y). In real browser, clientX/Y are always numbers.
      lastPosRef.current =
        orientation === "vertical" ? (e.clientX ?? 0) : (e.clientY ?? 0);
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    },
    [onPointerMove, onPointerUp, orientation],
  );

  // Cleanup on unmount — guard against listeners surviving a mid-drag unmount.
  useEffect(() => {
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  return (
    <div
      role="separator"
      aria-orientation={orientation === "vertical" ? "vertical" : "horizontal"}
      aria-label={ariaLabel}
      data-testid={testId}
      onPointerDown={onPointerDown}
      style={{
        cursor: orientation === "vertical" ? "col-resize" : "row-resize",
        userSelect: "none",
        background: "transparent", // D-12: cursor-only, no visible band
        ...style,
      }}
    />
  );
}
