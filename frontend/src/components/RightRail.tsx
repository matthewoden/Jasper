/**
 * RightRail — tab-row + single-mounted-panel right sidebar shell
 * (TAGS-01): a 30x30 icon-tab row (RightRailTabRow) mirroring the
 * left sidebar's SidebarTabRow, with exactly ONE panel mounted below it at
 * a time — Outline, Linked mentions, or Tags — driven by the persisted
 * rightPanel field (workspace.json via useWorkspace, Plan 01).
 *
 * Structure:
 *   <aside bg=--color-surface>            ← flush panel container
 *     <ResizeHandle left-edge />           ← left-edge width resize
 *     <header 40px>
 *       <RightRailTabRow />
 *     </header>
 *     <ActivePanel />   ← exactly one of Outline / Linked mentions / Tags
 *   </aside>
 *
 * The Tags tab (TAGS-02) is a single vault-wide
 * list — `RightRailTagsPanel` mounted directly, no upper active-note
 * section, no divider. All three panels (Outline, Linked mentions, Tags)
 * are header-less: the shared in-panel sub-header component is retired
 * app-wide, and no panel-level counts remain.
 *
 * This REPLACES the earlier three-section stacked/collapsible/resizable
 * layout (independent SectionHeader collapse state per section,
 * InterPanelDivider-driven height ratios) — that machinery has no analog
 * in the one-panel-at-a-time tab model and has been removed entirely,
 * along with its useTreeStore slices (see useTreeStore.ts).
 *
 * Background is --color-surface, filling the rail edge-to-edge so the tab
 * row sits flush against border-left (mock parity).
 *
 * Collapsed state (260721-cjt gap closure): `!expanded` now unmounts the
 * rail entirely (returns null) so the notes/editor area is flush with the
 * right window edge — no slim collapsed strip. The reopen control moved out
 * of the rail's own region and into the rightmost pane's tab bar (see
 * TabStrip.tsx's `tab-strip-right-cluster`, shown only when collapsed AND
 * the strip belongs to the rightmost leaf).
 */
import { useCallback, useEffect, useRef } from "react";
import type React from "react";

import { useTreeStore, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH } from "../lib/useTreeStore";
import { useBacklinks } from "../lib/useBacklinks";
import { RightRailTabRow } from "./RightRailTabRow";
import { OutlinePanel } from "./OutlinePanel";
import { LinkedMentionsPanel } from "./LinkedMentionsPanel";
import { RightRailTagsPanel } from "./RightRailTagsPanel";

interface Props {
  /** UUID of the currently open note. Null when no note is open. */
  activeNoteId: string | null;
  /** Optional style for grid placement; merged onto the root aside. */
  style?: React.CSSProperties;
}

export function RightRail({ activeNoteId, style }: Props) {
  const expanded = useTreeStore((s) => s.backlinksRailExpanded);
  const width = useTreeStore((s) => s.backlinksRailWidth);
  const setWidth = useTreeStore((s) => s.setBacklinksRailWidth);
  const rightPanel = useTreeStore((s) => s.rightPanel);

  const {
    backlinks,
    loading: backlinksLoading,
    error: backlinksError,
  } = useBacklinks(activeNoteId);

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
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  if (!expanded) return null;

  return (
    <aside
      ref={railRef as React.RefObject<HTMLDivElement>}
      style={{
        width,
        height: "100%",
        background: "var(--color-surface)",
        borderLeft: "1px solid var(--color-border)",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
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

      <header
        style={{
          height: 40,
          paddingLeft: 24,
          paddingRight: 24,
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
        }}
      >
        <RightRailTabRow />
      </header>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {rightPanel === "outline" && (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingTop: 16 }}>
            <OutlinePanel />
          </div>
        )}

        {rightPanel === "backlinks" && (
          <div style={{ flex: 1, minHeight: 0, overflow: "hidden", paddingTop: 16 }}>
            <LinkedMentionsPanel
              noteId={activeNoteId}
              backlinks={backlinks}
              loading={backlinksLoading}
              error={backlinksError}
            />
          </div>
        )}

        {rightPanel === "tags" && (
          <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            <RightRailTagsPanel />
          </div>
        )}
      </div>
    </aside>
  );
}
