/**
 * Generic resize handle — a cursor affordance with no visible band.
 *
 * preventDefault on pointerdown stops the native text-selection drag, and the
 * effect cleanup guards against listeners surviving a mid-drag unmount.
 *
 * SidebarResizeHandle keeps its own clamp math because it bounds against the
 * viewport, which cannot be expressed as a delta.
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
      e.preventDefault();
      draggingRef.current = true;
      lastPosRef.current =
        orientation === "vertical" ? (e.clientX ?? 0) : (e.clientY ?? 0);
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    },
    [onPointerMove, onPointerUp, orientation],
  );

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
        background: "transparent", // cursor-only, no visible band
        ...style,
      }}
    />
  );
}
