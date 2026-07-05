/**
 * InterPanelDivider — delegates pointer lifecycle to ResizeHandle (cursor-only
 * affordance; no visible band). Computes delta / railHeight to update a
 * height ratio; clamping is applied by the store setter.
 *
 * handleDrag reads the CURRENT ratio via a getter function (not a plain
 * value prop) instead of subscribing — the pointermove handler is attached
 * once on pointerdown, so a React subscription (or a stale-by-render-time
 * prop value) would capture a stale closure and only shift the ratio by one
 * delta from the start of the drag. getRatio/setRatio read/write the store
 * fresh on every call, so this holds regardless of when the callback closure
 * itself was created.
 *
 * Defaults to the original tagsPanelHeightRatio slice when getRatio/setRatio
 * are omitted, preserving the pre-Phase-20 single-divider call sites.
 */
import { useCallback } from "react";
import type React from "react";

import { useTreeStore } from "../lib/useTreeStore";
import { ResizeHandle } from "./ResizeHandle";

interface Props {
  railRef: React.RefObject<HTMLElement | null>;
  /** Reads the current ratio fresh from the store. Defaults to tagsPanelHeightRatio. */
  getRatio?: () => number;
  /** Writes the next ratio to the store (setter applies its own clamp). */
  setRatio?: (r: number) => void;
}

export function InterPanelDivider({ railRef, getRatio, setRatio }: Props) {
  const handleDrag = useCallback(
    (delta: number) => {
      const railHeight =
        railRef.current?.getBoundingClientRect().height ?? 1;
      if (railHeight <= 0) return;
      if (getRatio && setRatio) {
        setRatio(getRatio() + delta / railHeight);
        return;
      }
      const { tagsPanelHeightRatio, setTagsPanelHeightRatio } =
        useTreeStore.getState();
      setTagsPanelHeightRatio(tagsPanelHeightRatio + delta / railHeight);
    },
    [railRef, getRatio, setRatio],
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
