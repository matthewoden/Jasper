/**
 * Phase 6.5 — UX-T-01: InterPanelDivider.
 *
 * Phase 6.6 — Plan 06.6-01 (UX-CHROME-04 D-12/D-14/D-15):
 * Refactored to delegate pointer lifecycle to ResizeHandle. Removes the
 * 4px visible band (`background: var(--color-border)`) and the hover tint
 * state per D-13 (no hover visual change) and D-14 (apply cursor-only
 * affordance consistently).
 *
 * D-15: delegates to ResizeHandle — single source of truth for drag handle
 * pointer lifecycle.
 *
 * Ratio math: computes delta / railHeight to update tagsPanelHeightRatio.
 * Clamping [TAGS_PANEL_RATIO_MIN, TAGS_PANEL_RATIO_MAX] is applied at the
 * store setter side (single source of truth). This component passes the
 * unclamped updated ratio to setRatio and relies on the store to clamp.
 *
 * Accessibility: role="separator" + aria-orientation="horizontal" +
 * aria-label="Resize panels" delegated to ResizeHandle output.
 */
import { useCallback } from "react";
import type React from "react";

import { useTreeStore } from "../lib/useTreeStore";
import { ResizeHandle } from "./ResizeHandle";

interface Props {
  railRef: React.RefObject<HTMLElement | null>;
}

export function InterPanelDivider({ railRef }: Props) {
  const ratio = useTreeStore((s) => s.tagsPanelHeightRatio);
  const setRatio = useTreeStore((s) => s.setTagsPanelHeightRatio);

  const handleDrag = useCallback(
    (delta: number) => {
      const railHeight =
        railRef.current?.getBoundingClientRect().height ?? 1;
      if (railHeight <= 0) return;
      setRatio(ratio + delta / railHeight);
    },
    [railRef, ratio, setRatio],
  );

  return (
    <ResizeHandle
      orientation="horizontal"
      aria-label="Resize panels"
      onDrag={handleDrag}
      style={{ height: 12, flexShrink: 0 }}
    />
  );
}
