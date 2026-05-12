/**
 * Phase 6.5 — Plan 06.5-04: RightRail — restructured two-panel layout shell.
 *
 * Phase 6 D-46 anticipated multi-panel slots; Phase 6.5 exercises that capability.
 *
 * Structure (UI-SPEC §Surface 1-NEW):
 *   <aside bg=--color-bg>           ← floating-panel container
 *     <ResizeHandle left-edge />    ← existing left-edge width resize
 *     <div flex-column>             ← tags panel (ratio-driven height)
 *       <RightRailTagsPanel />
 *     </div>
 *     <InterPanelDivider railRef /> ← horizontal drag handle (Plan 02)
 *     <div flex-1>                  ← backlinks panel (remaining height)
 *       <BacklinksRail noteId />
 *     </div>
 *   </aside>
 *
 * The rail background is `var(--color-bg)` (not `--color-surface`) so the
 * 8px inset padding exposes background color between the two panel cards,
 * creating the "floating cards" aesthetic per D-03.
 *
 * Aria contract (updated from Phase 6):
 *   - Collapsed toggle: aria-label="Show backlinks panel" aria-expanded={false}
 *   - Vertical resize handle: role="separator" aria-orientation="vertical"
 *     aria-label="Resize backlinks panel"
 *   - InterPanelDivider: role="separator" aria-orientation="horizontal"
 *     aria-label="Resize panels" (provided by InterPanelDivider itself)
 */
import { useCallback, useRef } from "react";
import type React from "react";
import { ChevronLeft, Link as LinkIcon } from "lucide-react";

import {
  useTreeStore,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  RAIL_COLLAPSED_WIDTH,
} from "../lib/useTreeStore";
import { RightRailTagsPanel } from "./RightRailTagsPanel";
import { InterPanelDivider } from "./InterPanelDivider";
import { BacklinksRail } from "./BacklinksRail";

interface Props {
  /** UUID of the currently open note. Null when no note is open. */
  activeNoteId: string | null;
}

export function RightRail({ activeNoteId }: Props) {
  const expanded = useTreeStore((s) => s.backlinksRailExpanded);
  const width = useTreeStore((s) => s.backlinksRailWidth);
  const setExpanded = useTreeStore((s) => s.setBacklinksRailExpanded);
  const setWidth = useTreeStore((s) => s.setBacklinksRailWidth);
  const heightRatio = useTreeStore((s) => s.tagsPanelHeightRatio);
  const draggingRef = useRef(false);
  // railRef passed to InterPanelDivider for getBoundingClientRect ratio computation
  const railRef = useRef<HTMLElement>(null);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return;
      // Right-rail: drag LEFT to expand. Width = window.innerWidth - clientX.
      // Clamped to [RAIL_MIN_WIDTH, RAIL_MAX_WIDTH]; store also clamps in setter.
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
      e.preventDefault(); // prevent native text-selection drag
      draggingRef.current = true;
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    },
    [onPointerMove, onPointerUp],
  );

  if (!expanded) {
    return (
      <aside
        style={{
          width: RAIL_COLLAPSED_WIDTH,
          height: "100%",
          background: "var(--color-surface)",
          borderLeft: "1px solid var(--color-border)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: 8,
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label="Show backlinks panel"
          aria-expanded={false}
          title="Show backlinks panel"
          style={{
            width: 24,
            height: 24,
            background: "transparent",
            border: 0,
            color: "var(--color-muted)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
          }}
        >
          <LinkIcon size={14} />
          <ChevronLeft size={11} />
        </button>
      </aside>
    );
  }

  return (
    <aside
      ref={railRef as React.RefObject<HTMLDivElement>}
      style={{
        width,
        height: "100%",
        // UI-SPEC §Rail Container: --color-bg exposes the gap between panel cards
        // for the "floating panel" aesthetic (D-03). Changed from Phase 6 --color-surface.
        background: "var(--color-bg)",
        borderLeft: "1px solid var(--color-border)",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        padding: 8,
        boxSizing: "border-box",
        gap: 0,
      }}
    >
      {/* Vertical resize handle — left edge, 4px hit area, cursor: col-resize */}
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

      {/* Tags panel — height determined by tagsPanelHeightRatio */}
      {/* The -10px accounts for the divider footprint (4px visible + 4px padding each side = ~12px) */}
      <div
        style={{
          flex: `0 0 calc(${heightRatio * 100}% - 10px)`,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <RightRailTagsPanel />
      </div>

      {/* Inter-panel divider — horizontal drag handle from Plan 02 */}
      <InterPanelDivider railRef={railRef as React.RefObject<HTMLElement>} />

      {/* Backlinks panel — remaining height after tags panel + divider */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <BacklinksRail noteId={activeNoteId} />
      </div>
    </aside>
  );
}
