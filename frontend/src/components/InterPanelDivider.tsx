/**
 * Phase 6.5 — UX-T-01: InterPanelDivider.
 *
 * Horizontal port of SidebarResizeHandle. Drives
 * useTreeStore.setTagsPanelHeightRatio on pointermove. Computes ratio
 * from the parent rail's bounding rect so it works regardless of where
 * the rail sits in the viewport. Clamped [0.2, 0.8] at the setter side
 * (single source of truth — store clamps in setTagsPanelHeightRatio).
 *
 * The store-side clamp is the load-bearing one; this component still
 * clamps in onPointerMove so the store never sees out-of-range values
 * (defense in depth + makes the test on clamp behavior verifiable
 * against the component directly).
 *
 * Hover tint: implemented via inline onPointerEnter/onPointerLeave state
 * to avoid adding a CSS selector in theme.css that would depend on
 * data-testid (test-only attribute) in production styles. The tint color
 * is token-driven: color-mix(in srgb, var(--color-fg) 8%, transparent).
 *
 * Accessibility: role="separator" + aria-orientation="horizontal" +
 * aria-label="Resize panels" matches the WAI-ARIA window-splitter
 * convention. (v1 ships pointer-driven only; keyboard arrow-key resize
 * is deferred.)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

import {
  useTreeStore,
  TAGS_PANEL_RATIO_MIN,
  TAGS_PANEL_RATIO_MAX,
} from "../lib/useTreeStore";

interface Props {
  railRef: React.RefObject<HTMLElement>;
}

export function InterPanelDivider({ railRef }: Props) {
  const setRatio = useTreeStore((s) => s.setTagsPanelHeightRatio);
  const draggingRef = useRef(false);
  const [hovered, setHovered] = useState(false);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current || !railRef.current) return;
      const rect = railRef.current.getBoundingClientRect();
      if (rect.height <= 0) return;
      const raw = (e.clientY - rect.top) / rect.height;
      const clamped = Math.min(TAGS_PANEL_RATIO_MAX, Math.max(TAGS_PANEL_RATIO_MIN, raw));
      setRatio(clamped);
    },
    [railRef, setRatio],
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
      aria-orientation="horizontal"
      aria-label="Resize panels"
      data-testid="inter-panel-divider"
      onPointerDown={onPointerDown}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={{
        height: 4,
        paddingTop: 4,
        paddingBottom: 4,
        boxSizing: "content-box",
        background: hovered
          ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
          : "var(--color-border)",
        borderRadius: 2,
        cursor: "row-resize",
        userSelect: "none",
      }}
    />
  );
}
