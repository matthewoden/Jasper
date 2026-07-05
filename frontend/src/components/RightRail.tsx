/**
 * RightRail — three-section right sidebar shell (Phase 20 rework, D-01/D-02/
 * D-03/D-04/D-07): Outline → Linked mentions → Tags, each behind a unified
 * SectionHeader with independent collapse state.
 *
 * Structure:
 *   <aside bg=--color-bg>                 ← floating-panel container
 *     <ResizeHandle left-edge />           ← left-edge width resize
 *     <div flex-column>                   ← Outline section
 *       <SectionHeader />
 *       <OutlinePanel /> (when expanded)
 *     </div>
 *     <InterPanelDivider /> (Outline↔Linked mentions, only if both expanded)
 *     <div flex-column>                   ← Linked mentions section
 *       <SectionHeader count={distinct linking notes} />
 *       <LinkedMentionsPanel noteId /> (when expanded)
 *     </div>
 *     <InterPanelDivider /> (Linked mentions↔Tags, only if both expanded)
 *     <div flex-column>                   ← Tags section
 *       <SectionHeader count={tags.length} />
 *       <RightRailTagsPanel /> (when expanded)
 *     </div>
 *   </aside>
 *
 * Background is --color-bg (not --color-surface) so the 8px inset exposes
 * background color between the three section cards, giving the "floating
 * cards" aesthetic.
 *
 * Space model (D-04): the LAST expanded section (in Outline → Linked
 * mentions → Tags order) always absorbs the remaining height via flex: 1;
 * every EARLIER expanded section uses its own dedicated ratio
 * (outlineHeightRatio / linkedMentionsHeightRatio) via a calc() flex-basis.
 * A collapsed section renders only its 32px header and takes no share of
 * the drag ratio. Because Tags is structurally last, it is always the
 * remainder-taker whenever it is expanded — matching "Tags takes the
 * remainder" without any special-casing.
 *
 * All three sections are ALWAYS MOUNTED; only the whole rail (gated on
 * backlinksRailExpanded) can disappear entirely.
 */
import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import type { CSSProperties } from "react";

import {
  useTreeStore,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
} from "../lib/useTreeStore";
import { useBacklinks } from "../lib/useBacklinks";
import { useTagBrowser } from "../lib/useTagBrowser";
import { SectionHeader } from "./SectionHeader";
import { OutlinePanel } from "./OutlinePanel";
import { LinkedMentionsPanel } from "./LinkedMentionsPanel";
import { RightRailTagsPanel } from "./RightRailTagsPanel";
import { InterPanelDivider } from "./InterPanelDivider";

interface Props {
  /** UUID of the currently open note. Null when no note is open. */
  activeNoteId: string | null;
  /** Optional style for grid placement; merged onto the root aside. */
  style?: React.CSSProperties;
}

/** Offset subtracted from a ratio-driven flex-basis to leave room for an adjacent divider. */
const DIVIDER_FLEX_ADJUST = 10;

type SectionKey = "outline" | "mentions" | "tags";

function sectionFlexStyle(
  expanded: boolean,
  isRemainder: boolean,
  ratio: number,
): CSSProperties {
  if (!expanded) {
    return { flex: "0 0 auto" };
  }
  if (isRemainder) {
    return { flex: 1, minHeight: 0, overflow: "hidden" };
  }
  return {
    flex: `0 0 calc(${ratio * 100}% - ${DIVIDER_FLEX_ADJUST}px)`,
    minHeight: 0,
    overflow: "hidden",
  };
}

export function RightRail({ activeNoteId, style }: Props) {
  const expanded = useTreeStore((s) => s.backlinksRailExpanded);
  const width = useTreeStore((s) => s.backlinksRailWidth);
  const setWidth = useTreeStore((s) => s.setBacklinksRailWidth);

  const outlinePanelExpanded = useTreeStore((s) => s.outlinePanelExpanded);
  const setOutlinePanelExpanded = useTreeStore((s) => s.setOutlinePanelExpanded);
  const linkedMentionsPanelExpanded = useTreeStore((s) => s.linkedMentionsPanelExpanded);
  const setLinkedMentionsPanelExpanded = useTreeStore(
    (s) => s.setLinkedMentionsPanelExpanded,
  );
  const tagsPanelExpanded = useTreeStore((s) => s.tagsPanelExpanded);
  const setTagsPanelExpanded = useTreeStore((s) => s.setTagsPanelExpanded);

  const outlineHeightRatio = useTreeStore((s) => s.outlineHeightRatio);
  const setOutlineHeightRatio = useTreeStore((s) => s.setOutlineHeightRatio);
  const linkedMentionsHeightRatio = useTreeStore((s) => s.linkedMentionsHeightRatio);
  const setLinkedMentionsHeightRatio = useTreeStore(
    (s) => s.setLinkedMentionsHeightRatio,
  );

  // Single shared fetch (WR-07): the count badge and LinkedMentionsPanel's
  // cards must render the same snapshot, so the panel receives this result
  // as props instead of mounting its own useBacklinks instance.
  const {
    backlinks,
    loading: backlinksLoading,
    error: backlinksError,
  } = useBacklinks(activeNoteId);
  const linkedMentionsCount = backlinks?.length ?? 0;
  const { tags } = useTagBrowser();

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

  const order: Array<{ key: SectionKey; expanded: boolean }> = [
    { key: "outline", expanded: outlinePanelExpanded },
    { key: "mentions", expanded: linkedMentionsPanelExpanded },
    { key: "tags", expanded: tagsPanelExpanded },
  ];
  const expandedKeys = order.filter((o) => o.expanded).map((o) => o.key);
  const lastExpandedKey = expandedKeys[expandedKeys.length - 1] ?? null;

  const dividerBetweenOutlineAndMentions =
    outlinePanelExpanded && linkedMentionsPanelExpanded;
  const dividerBetweenMentionsAndTags =
    linkedMentionsPanelExpanded && tagsPanelExpanded;

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

      {/* Outline section */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          ...sectionFlexStyle(
            outlinePanelExpanded,
            lastExpandedKey === "outline",
            outlineHeightRatio,
          ),
        }}
      >
        <SectionHeader
          title="Outline"
          expanded={outlinePanelExpanded}
          onToggle={() => setOutlinePanelExpanded(!outlinePanelExpanded)}
          ariaCollapsedLabel="Expand Outline panel"
          ariaExpandedLabel="Collapse Outline panel"
        />
        {outlinePanelExpanded && (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <OutlinePanel />
          </div>
        )}
      </div>

      {dividerBetweenOutlineAndMentions && (
        <InterPanelDivider
          railRef={railRef as React.RefObject<HTMLElement>}
          getRatio={() => useTreeStore.getState().outlineHeightRatio}
          setRatio={setOutlineHeightRatio}
        />
      )}

      {/* Linked mentions section */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          ...sectionFlexStyle(
            linkedMentionsPanelExpanded,
            lastExpandedKey === "mentions",
            linkedMentionsHeightRatio,
          ),
        }}
      >
        <SectionHeader
          title="Linked mentions"
          expanded={linkedMentionsPanelExpanded}
          onToggle={() => setLinkedMentionsPanelExpanded(!linkedMentionsPanelExpanded)}
          count={linkedMentionsCount}
          ariaCollapsedLabel="Expand Linked mentions panel"
          ariaExpandedLabel="Collapse Linked mentions panel"
        />
        {linkedMentionsPanelExpanded && (
          <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            <LinkedMentionsPanel
              noteId={activeNoteId}
              backlinks={backlinks}
              loading={backlinksLoading}
              error={backlinksError}
            />
          </div>
        )}
      </div>

      {dividerBetweenMentionsAndTags && (
        <InterPanelDivider
          railRef={railRef as React.RefObject<HTMLElement>}
          getRatio={() => useTreeStore.getState().linkedMentionsHeightRatio}
          setRatio={setLinkedMentionsHeightRatio}
        />
      )}

      {/* Tags section */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          ...sectionFlexStyle(tagsPanelExpanded, lastExpandedKey === "tags", 1),
        }}
      >
        <SectionHeader
          title="Tags"
          expanded={tagsPanelExpanded}
          onToggle={() => setTagsPanelExpanded(!tagsPanelExpanded)}
          count={tags.length}
          ariaCollapsedLabel="Expand Tags panel"
          ariaExpandedLabel="Collapse Tags panel"
        />
        {tagsPanelExpanded && (
          <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            <RightRailTagsPanel />
          </div>
        )}
      </div>
    </aside>
  );
}
