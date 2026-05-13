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
 * UAT 2026-05-12 fix: read the CURRENT ratio via useTreeStore.getState()
 * inside handleDrag instead of subscribing — the previous closure captured
 * the ratio at mount and stayed stale across pointermove events within a
 * single drag. Symptom: dragging only ever shifted the ratio by one
 * `delta`'s worth from the starting value, so the divider visibly snapped
 * back to ~its origin on every move. The ResizeHandle pointermove handler
 * is attached once on pointerdown, so React's re-render-on-state-change
 * never had a chance to refresh the closure.
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
  const handleDrag = useCallback(
    (delta: number) => {
      const railHeight =
        railRef.current?.getBoundingClientRect().height ?? 1;
      if (railHeight <= 0) return;
      // Read fresh ratio every move so the drag accumulates correctly.
      const { tagsPanelHeightRatio, setTagsPanelHeightRatio } =
        useTreeStore.getState();
      setTagsPanelHeightRatio(tagsPanelHeightRatio + delta / railHeight);
    },
    [railRef],
  );

  return (
    <ResizeHandle
      orientation="horizontal"
      aria-label="Resize panels"
      data-testid="inter-panel-divider"
      onDrag={handleDrag}
      style={{ height: 12, flexShrink: 0 }}
    />
  );
}
