/**
 * RightRail — two-panel layout shell (tags + backlinks).
 *
 * Structure:
 *   <aside bg=--color-bg>           ← floating-panel container
 *     <ResizeHandle left-edge />    ← left-edge width resize
 *     <div flex-column>             ← tags panel (ratio-driven height)
 *       <RightRailTagsPanel />
 *     </div>
 *     <InterPanelDivider railRef /> ← horizontal drag handle
 *     <div flex-1>                  ← backlinks panel (remaining height)
 *       <BacklinksRail noteId />
 *     </div>
 *   </aside>
 *
 * Background is --color-bg (not --color-surface) so the 8px inset exposes
 * background color between the two panel cards, giving the "floating cards"
 * aesthetic.
 *
 * When expanded=false the component returns null (no collapsed aside). When
 * both panelSelector booleans are false while expanded=true, a useEffect
 * auto-collapses the rail.
 */
import { useCallback, useEffect, useRef } from "react";
import type React from "react";

import {
  useTreeStore,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
} from "../lib/useTreeStore";
import { RightRailTagsPanel } from "./RightRailTagsPanel";
import { InterPanelDivider } from "./InterPanelDivider";
import { BacklinksRail } from "./BacklinksRail";

interface Props {
  /** UUID of the currently open note. Null when no note is open. */
  activeNoteId: string | null;
  /** Optional style for grid placement; merged onto the root aside. */
  style?: React.CSSProperties;
}

export function RightRail({ activeNoteId, style }: Props) {
  const expanded = useTreeStore((s) => s.backlinksRailExpanded);
  const width = useTreeStore((s) => s.backlinksRailWidth);
  const setExpanded = useTreeStore((s) => s.setBacklinksRailExpanded);
  const setWidth = useTreeStore((s) => s.setBacklinksRailWidth);
  const heightRatio = useTreeStore((s) => s.tagsPanelHeightRatio);
  const panelSelector = useTreeStore((s) => s.panelSelector);
  const draggingRef = useRef(false);
  const railRef = useRef<HTMLElement>(null);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const newWidth = Math.min(
        RAIL_MAX_WIDTH,
        Math.max(RAIL_MIN_WIDTH, window.innerWidth - e.clientX),
      );
      setWidth(newWidth);
    },
    [setWidth],
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

  useEffect(() => {
    if (expanded && !panelSelector.tags && !panelSelector.backlinks) {
      setExpanded(false);
    }
  }, [expanded, panelSelector.tags, panelSelector.backlinks, setExpanded]);

  if (!expanded) return null;

  const bothPanelsVisible = panelSelector.tags && panelSelector.backlinks;

  return (
    <aside
      ref={railRef as React.RefObject<HTMLDivElement>}
      style={{
        width,
        height: "100%",
        background: "var(--color-bg)",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        padding: 8,
        boxSizing: "border-box",
        gap: 0,
        ...style,
      }}
    >
      {/* Vertical resize handle — left edge, cursor-only affordance */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize backlinks panel"
        onPointerDown={onPointerDown}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          width: 4,
          cursor: "col-resize",
          userSelect: "none",
          zIndex: 1,
        }}
      />

      {/* Tags panel — height driven by tagsPanelHeightRatio */}
      {panelSelector.tags && (
        <div
          style={{
            flex: bothPanelsVisible ? `0 0 calc(${heightRatio * 100}% - 10px)` : 1,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <RightRailTagsPanel />
        </div>
      )}

      {/* Inter-panel divider — only when both panels are visible */}
      {bothPanelsVisible && (
        <InterPanelDivider railRef={railRef as React.RefObject<HTMLElement>} />
      )}

      {/* Backlinks panel — fills remaining height */}
      {panelSelector.backlinks && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <BacklinksRail noteId={activeNoteId} />
        </div>
      )}
    </aside>
  );
}
