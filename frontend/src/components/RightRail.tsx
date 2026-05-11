/**
 * Phase 6 — Plan 06-07 (D-46): RightRail — right-side layout shell.
 *
 * Owns:
 *   - The collapsed (32px strip) / expanded toggle affordance.
 *   - The resize handle positioned at the left edge of the expanded rail.
 *   - Grid column width management via useTreeStore (backlinksRailWidth,
 *     backlinksRailExpanded).
 *   - Its `children` prop renders <BacklinksRail> in Phase 6 and can render
 *     future panels (e.g. <OutlineTOC>) without structural rework.
 *
 * Resize handle pattern mirrors SidebarResizeHandle.tsx with inverted drag
 * direction: drag LEFT to expand → width = window.innerWidth − e.clientX.
 * See 06-PATTERNS.md §RightRail.tsx and 06-UI-SPEC.md §Surface 2.
 *
 * Aria contract (06-UI-SPEC.md §Accessibility Contract):
 *   - Collapsed toggle: aria-label="Show backlinks panel" aria-expanded={false}
 *   - Resize handle: role="separator" aria-orientation="vertical" aria-label="Resize backlinks panel"
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

interface Props {
  children?: React.ReactNode;
}

export function RightRail({ children }: Props) {
  const expanded = useTreeStore((s) => s.backlinksRailExpanded);
  const width = useTreeStore((s) => s.backlinksRailWidth);
  const setExpanded = useTreeStore((s) => s.setBacklinksRailExpanded);
  const setWidth = useTreeStore((s) => s.setBacklinksRailWidth);
  const draggingRef = useRef(false);

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
      style={{
        width,
        height: "100%",
        background: "var(--color-surface)",
        borderLeft: "1px solid var(--color-border)",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}
    >
      {/* Resize handle — left edge, 4px hit area, cursor: col-resize */}
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
      {children}
    </aside>
  );
}
