/**
 * InterPanelDivider — delegates pointer lifecycle to ResizeHandle (cursor-only
 * affordance; no visible band). Computes delta / railHeight to update
 * tagsPanelHeightRatio; clamping is applied by the store setter.
 *
 * handleDrag reads the CURRENT ratio via useTreeStore.getState() instead of
 * subscribing — the pointermove handler is attached once on pointerdown, so a
 * React subscription would capture a stale closure and only shift the ratio by
 * one delta from the start of the drag.
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
