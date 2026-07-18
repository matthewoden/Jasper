/**
 * TabStrip — a leaf-scoped editor tab row (Phase 25 / WS-03: one strip per
 * pane, not a workspace singleton).
 *
 * Composes the Plan-03 presentational pieces: each ordered tab renders a
 * `TabPill` wrapped in `TabContextMenu`, with a `TabOverflowDropdown` at the
 * right edge listing tabs that don't fit. Reorder uses pointer-event drag
 * (pointerdown on the wrapper → pointermove/pointerup on the strip) because
 * native HTML5 DnD does not deliver drop events reliably in this context.
 * The strip div handles move/up so that setPointerCapture is unnecessary —
 * avoiding Chromium's click-target redirection that captures would cause.
 *
 * Capture-phase keyboard shortcuts (Alt+]/Alt+[/Ctrl+Tab cycle, Alt+W close)
 * are registered here, gated on `usePaneStore.getState().activePaneId ===
 * leafId` (Pitfall 3 / T-25-06-Dup): with N leaves mounted, N TabStrips each
 * register a window listener, so every leaf's handler must no-op unless its
 * OWN leaf is the active pane — otherwise one Alt+W keypress would close a
 * tab in every pane simultaneously.
 *
 * Closing ALWAYS routes through `onRequestClose` (flush-aware; App.tsx/Plan 05
 * owns the flush+confirm orchestration) — never `closeTab` directly, so a close
 * can never drop unsaved edits.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { usePaneStore } from "../lib/usePaneStore";
import type { Tab } from "../lib/useTabStore";
import { useTreeStore } from "../lib/useTreeStore";
import { TabPill } from "./TabPill";
import { TabContextMenu } from "./TabContextMenu";
import { TabOverflowDropdown } from "./TabOverflowDropdown";
import { computeHiddenTabIds, computeDropIndex, MIN_TAB_WIDTH } from "../lib/tabOverflow";

/** Set equality used to preserve state identity (avoid re-render churn). */
function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

// Reserved strip chrome that is never available to tabs:
//   strip horizontal padding (8) + pinned new-tab button (26) + the tab-bar
//   right cluster + the tab-bar left cluster (37).
//   Right cluster: 1 (borderLeft) + 8 (paddingLeft) + 4 (flex gap) + 28
//   (right toggle) = 41. The old panel-selector dropdown trigger was removed
//   in Phase 20 (D-01) — the right-sidebar toggle is now the sole control in
//   this cluster. Left cluster: 28 (left toggle) + 8 (paddingRight) + 1
//   (borderRight) = 37. Split placement supersedes the original single
//   right-hand cluster (owner revision 2026-07-02, gap 3 / TABUI-02). The
//   overflow dropdown trigger (28px) is reserved separately, inside
//   computeHiddenTabIds, ONLY when overflow occurs.
const RIGHT_CLUSTER = 1 + 8 + 4 + 28;
const LEFT_CLUSTER = 37;
export const RESERVED = 8 + 26 + RIGHT_CLUSTER + LEFT_CLUSTER;
const OVERFLOW_BTN = 28;

/** 28x28 icon button shared by the tab-bar's far-left and far-right clusters —
 *  same hover-fill idiom (originally hosted in the now-dissolved chrome
 *  wrapper, D-04). */
const rightClusterButtonBase: CSSProperties = {
  width: 28,
  height: 28,
  padding: 6,
  background: "transparent",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
};

interface RightClusterToggleProps {
  ariaLabel: string;
  onClick: () => void;
  icon: React.ReactNode;
}

function RightClusterToggle({
  ariaLabel,
  onClick,
  icon,
}: RightClusterToggleProps): React.JSX.Element {
  const [hovering, setHovering] = useState(false);
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        ...rightClusterButtonBase,
        background: hovering
          ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
          : "transparent",
      }}
    >
      {icon}
    </button>
  );
}

// Movement threshold (px) before a pointerdown is treated as a drag.
// Small enough to feel responsive; large enough to not fire on a click.
const DRAG_THRESHOLD = 5;

export interface TabStripProps {
  /** This strip's owning leaf id — gates the window keydown listener to the active pane. */
  leafId: string;
  tabs: Tab[];
  activeTabId: string | null;
  deletedTabIds: Set<string>;
  /** Derived from useFileTree by note UUID (TAB-12 live rename). */
  titleForTab: (noteId: string) => string;
  onSelectTab: (tabId: string) => void;
  /** Flush-aware close (Plan 05 supplies the handler). */
  onRequestClose: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  onCloseToRight: (tabId: string) => void;
  onOpenRight: (tabId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  /** Create a new untitled note and open it as a tab (TAB-14, + button / ⌥T). */
  onNewTab: () => void;
  /** Cycle this leaf's active tab (Alt+]/Alt+[/Ctrl+Tab/Ctrl+Shift+Tab) — leaf-scoped, not workspace-wide. */
  onCycleTab: (direction: 1 | -1) => void;
  /** Test-only: force a set of tab ids into the overflow dropdown. */
  forceHiddenTabIds?: Set<string>;
  style?: CSSProperties;
}

/** + button styled like SidebarToolbar's icon buttons; pinned at the strip's
 *  right edge (flexShrink:0) so it survives tab overflow. */
const newTabButtonStyle: CSSProperties = {
  width: 24,
  height: 24,
  padding: 4,
  margin: "0 0 4px 2px",
  background: "transparent",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
  flexShrink: 0,
};

/** Tab-shaped + button for the zero-tab empty state — reads as a real tab
 *  silhouette (TabPill's 40px flush rectangular pill seated on the 40px strip)
 *  rather than a bare icon, so the empty state still looks like a tab row. */
const emptyStateNewTabButtonStyle: CSSProperties = {
  height: 40,
  minWidth: 80,
  padding: "0 8px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--color-border)",
  borderRadius: 0,
  color: "var(--color-muted)",
  cursor: "pointer",
  flexShrink: 0,
};

/** Empty-state new-tab button: own hover state so it tints like a TabPill
 *  (accent-12%) without leaking a hook into TabStrip's normal render path. */
function EmptyStateNewTabButton({ onNewTab }: { onNewTab: () => void }) {
  const [hovering, setHovering] = useState(false);
  return (
    <button
      type="button"
      title="New tab (⌥T)"
      aria-label="New tab"
      data-testid="new-tab-button"
      onClick={onNewTab}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        ...emptyStateNewTabButtonStyle,
        background: hovering
          ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
          : "var(--color-surface)",
      }}
    >
      <Plus size={16} aria-hidden="true" />
    </button>
  );
}

// No borderBottom (TABUI-01): per-tab right borders + the active top-accent
// carry the separation now. A strip-level bottom border would draw a seam
// across the active tab's --color-bg background, undermining the "seated on
// the editor column below" look that background is meant to convey.
const tabStripStyle: CSSProperties = {
  position: "relative",
  height: 40,
  background: "var(--color-surface)",
  padding: "0 4px",
  display: "flex",
  alignItems: "flex-end",
  gap: 0,
  overflow: "hidden",
  flexShrink: 0,
};

/** Absolute overlay insertion indicator: sits on top of the tab row at the drop
 *  boundary without consuming flex width, so pills never shift sideways. */
const dropOverlayStyle: CSSProperties = {
  position: "absolute",
  top: 2,
  height: 32,
  width: 2,
  background: "var(--color-accent)",
  pointerEvents: "none",
};

/** State tracked across the pointer-drag lifecycle (mutable ref, not state). */
interface DragRef {
  tabId: string;
  fromIndex: number;
  startX: number;
  active: boolean;
  /** Title of the dragged tab — shown in the ghost element. */
  title: string;
  /** Whether the dragged tab is the active tab (reflected in ghost pill). */
  isActive: boolean;
  /** Whether the dragged tab's note is deleted (reflected in ghost pill). */
  isDeleted: boolean;
}

/** Render-only ghost position; null when no drag is active. */
interface DragGhost {
  tabId: string;
  title: string;
  x: number;
  y: number;
  isActive: boolean;
  isDeleted: boolean;
}

export function TabStrip({
  leafId,
  tabs,
  activeTabId,
  deletedTabIds,
  titleForTab,
  onSelectTab,
  onRequestClose,
  onCloseOthers,
  onCloseToRight,
  onOpenRight,
  onReorder,
  onNewTab,
  onCycleTab,
  forceHiddenTabIds,
  style,
}: TabStripProps) {
  // Split placement (owner revision 2026-07-02, gap 3 / TABUI-02, supersedes
  // the original D-04 right-hand cluster): the left-sidebar toggle sits alone
  // in a far-left cluster; the right-sidebar toggle sits alone in a far-right
  // cluster (the panel-selector dropdown that used to share this cluster was
  // removed in Phase 20, D-01). The right toggle is ALWAYS rendered (no
  // panel-selector gating — that gate belonged to the old chrome wrapper and
  // is intentionally dropped, see TabStrip.test.tsx).
  const notesSidebarVisible = useTreeStore((s) => s.notesSidebarVisible);
  const setNotesSidebarVisible = useTreeStore((s) => s.setNotesSidebarVisible);
  const backlinksRailExpanded = useTreeStore((s) => s.backlinksRailExpanded);
  const setBacklinksRailExpanded = useTreeStore(
    (s) => s.setBacklinksRailExpanded,
  );

  // Whether THIS strip's leaf is the active pane (D-05 active-pane cue): the
  // active tab's top-accent reads purple (--color-accent) only in the active
  // pane, and a neutral gray (--color-muted) in inactive panes — so the purple
  // accent itself signals which pane is active. Subscribed (not getState) so
  // the accent flips live when focus moves between panes.
  const isActivePane = usePaneStore((s) => s.activePaneId === leafId);

  const sidebarLabel = notesSidebarVisible
    ? "Hide notes sidebar"
    : "Show notes sidebar";
  const railLabel = backlinksRailExpanded ? "Hide panels" : "Show panels";

  const leftCluster = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        borderRight: "1px solid var(--color-border-inner)",
        paddingRight: 8,
        flexShrink: 0,
      }}
      data-testid="tab-strip-left-cluster"
    >
      <RightClusterToggle
        ariaLabel={sidebarLabel}
        onClick={() => setNotesSidebarVisible(!notesSidebarVisible)}
        icon={
          notesSidebarVisible ? (
            <ChevronLeft size={16} aria-hidden="true" />
          ) : (
            <ChevronRight size={16} aria-hidden="true" />
          )
        }
      />
    </div>
  );

  const rightCluster = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        borderLeft: "1px solid var(--color-border-inner)",
        paddingLeft: 8,
        flexShrink: 0,
      }}
      data-testid="tab-strip-right-cluster"
    >
      <RightClusterToggle
        ariaLabel={railLabel}
        onClick={() => setBacklinksRailExpanded(!backlinksRailExpanded)}
        icon={
          backlinksRailExpanded ? (
            <ChevronRight size={16} aria-hidden="true" />
          ) : (
            <ChevronLeft size={16} aria-hidden="true" />
          )
        }
      />
    </div>
  );

  // Render-only ghost state: tracks cursor position while drag is active.
  // dragRef remains the authoritative drag source; this is purely for display.
  const [dragGhost, setDragGhost] = useState<DragGhost | null>(null);
  // Strip-relative x of the insertion indicator overlay; null when no drag is active.
  const [dropIndicatorX, setDropIndicatorX] = useState<number | null>(null);

  // Pointer drag state — mutable ref avoids triggering re-renders mid-drag.
  const dragRef = useRef<DragRef | null>(null);
  // After a real drag the pointerup triggers a click on the same element;
  // this ref suppresses that click so selection does not fire post-drag.
  const suppressClickRef = useRef(false);

  // Keyboard shortcuts need the current onRequestClose/onCycleTab/tabs/activeTabId
  // without re-registering the window listener on every render — thread each
  // through a ref kept fresh each render (registration effect below has an
  // empty-ish dep array, keyed only on leafId).
  const requestCloseRef = useRef(onRequestClose);
  requestCloseRef.current = onRequestClose;
  const onCycleTabRef = useRef(onCycleTab);
  onCycleTabRef.current = onCycleTab;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  // Overflow measurement: with a uniform minimum pill width the only DOM read
  // needed is the strip's content-box width — the hidden-tab decision is the
  // pure computeHiddenTabIds. Measured after layout; recomputed on resize.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [measuredHiddenIds, setMeasuredHiddenIds] = useState<Set<string>>(
    () => new Set(),
  );

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip === null) return;

    const measure = () => {
      // No layout yet (initial mount / jsdom): leave every tab visible rather
      // than over-hiding against a zero/negative width budget.
      if (strip.clientWidth === 0) {
        setMeasuredHiddenIds((prev) => (prev.size === 0 ? prev : new Set()));
        return;
      }
      const available = strip.clientWidth - RESERVED;
      const hidden = computeHiddenTabIds({
        tabIds: tabs.map((t) => t.id),
        activeTabId,
        availableWidth: available,
        minTabWidth: MIN_TAB_WIDTH,
        overflowButtonWidth: OVERFLOW_BTN,
      });
      setMeasuredHiddenIds((prev) => (sameSet(prev, hidden) ? prev : hidden));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [tabs, activeTabId]);

  // Capture-phase keyboard shortcuts (D-13), gated to the ACTIVE pane
  // (Pitfall 3 / T-25-06-Dup): every mounted leaf's TabStrip registers this
  // same window listener, so without the guard below N leaves would all act
  // on one keypress. Registered once per leafId; tabs/activeTabId/callbacks
  // are read through refs kept fresh each render so the listener stays stable.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (usePaneStore.getState().activePaneId !== leafId) return;
      if (tabsRef.current.length === 0) return;

      // Alt+W → request close of the active tab (flush-aware via prop).
      // Never bind plain Cmd/Ctrl+W — the browser owns it.
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyW") {
        e.preventDefault();
        e.stopPropagation();
        if (activeTabIdRef.current !== null) requestCloseRef.current(activeTabIdRef.current);
        return;
      }

      // Next: Alt+] OR Ctrl+Tab (no shift).
      const isNextAlt =
        e.altKey && !e.metaKey && !e.ctrlKey && e.code === "BracketRight";
      const isNextCtrlTab =
        e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab" && !e.shiftKey;
      if (isNextAlt || isNextCtrlTab) {
        e.preventDefault();
        onCycleTabRef.current(1);
        return;
      }

      // Prev: Alt+[ OR Ctrl+Shift+Tab.
      const isPrevAlt =
        e.altKey && !e.metaKey && !e.ctrlKey && e.code === "BracketLeft";
      const isPrevCtrlTab =
        e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab" && e.shiftKey;
      if (isPrevAlt || isPrevCtrlTab) {
        e.preventDefault();
        onCycleTabRef.current(-1);
        return;
      }
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [leafId]);

  // Clear the ghost if the window loses focus mid-drag, or if the button is
  // released anywhere in the window, so a drag can never get stranded (gap 5 /
  // CR-02). The window pointerup is a safety-net dismiss for releases outside
  // the strip — it never fires a reorder; the strip's own onPointerUp still
  // owns in-strip drops.
  useEffect(() => {
    function dismissStrandedDrag() {
      if (dragRef.current === null) return;
      dragRef.current = null;
      setDropIndicatorX(null);
      setDragGhost(null);
      suppressClickRef.current = false;
    }
    window.addEventListener("blur", dismissStrandedDrag);
    window.addEventListener("pointerup", dismissStrandedDrag);
    return () => {
      window.removeEventListener("blur", dismissStrandedDrag);
      window.removeEventListener("pointerup", dismissStrandedDrag);
    };
  }, []);

  // Single source for the + button so the empty-state and normal branches share
  // identical markup.
  const newTabButton = (
    <button
      type="button"
      title="New tab (⌥T)"
      aria-label="New tab"
      data-testid="new-tab-button"
      onClick={onNewTab}
      style={newTabButtonStyle}
    >
      <Plus size={16} aria-hidden="true" />
    </button>
  );

  // Empty state (TAB-14): instead of returning null, render the strip with ONLY
  // the + button. An always-visible + means there is never a state with no way
  // to create a tab (discoverability + bootstrap). Consequence: grid row 2 is
  // now always 36px — the strip no longer collapses at zero tabs (intended).
  if (tabs.length === 0) {
    return (
      <div
        ref={stripRef}
        role="tablist"
        aria-label="Open tabs"
        style={{ ...tabStripStyle, ...style }}
        data-testid="tab-strip"
      >
        {leftCluster}
        <EmptyStateNewTabButton onNewTab={onNewTab} />
        <div style={{ flex: "1 1 auto" }} />
        {rightCluster}
      </div>
    );
  }

  const hiddenIds = forceHiddenTabIds ?? measuredHiddenIds;
  const visibleTabs = tabs.filter((t) => !hiddenIds.has(t.id));
  const hiddenTabs = tabs.filter((t) => hiddenIds.has(t.id));

  /** Compute which visible-tab id the dragged pill is hovering before, by comparing
   *  the current x position against each visible pill wrapper's horizontal midpoint. */
  function computeDropTarget(clientX: number): string | null {
    if (!stripRef.current) return null;
    const wrappers = stripRef.current.querySelectorAll<HTMLElement>(
      "[data-tab-wrapper]",
    );
    for (const wrapper of wrappers) {
      const rect = wrapper.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        return wrapper.dataset.tabWrapper ?? null;
      }
    }
    // Past the last pill — insertion goes after the last visible tab.
    return null;
  }

  function handlePointerDown(
    tab: Tab,
    fromIndex: number,
    e: PointerEvent<HTMLDivElement>,
  ) {
    // Only primary button initiates a drag; middle/right fall through for
    // auxclick/context-menu so those behaviors keep working.
    if (e.button !== 0) return;
    dragRef.current = {
      tabId: tab.id,
      fromIndex,
      startX: e.clientX,
      active: false,
      title: titleForTab(tab.noteId),
      isActive: tab.id === activeTabId,
      isDeleted: deletedTabIds.has(tab.noteId),
    };
  }

  // Strip-level pointer handlers: the strip div is large enough to cover all pill
  // wrappers, so we get move/up events without needing setPointerCapture on each
  // wrapper (avoiding Chromium's click-target redirection that capture would cause).
  function handleStripPointerMove(e: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    // The primary button was already released outside the strip (no pointerup
    // ever reached us) — abandon the stale drag instead of resuming it.
    if (e.buttons === 0) {
      handleStripPointerCancel();
      return;
    }
    const moved = Math.abs(e.clientX - drag.startX);
    if (!drag.active && moved > DRAG_THRESHOLD) {
      drag.active = true;
      // Clear any text selection accumulated before the threshold was crossed.
      window.getSelection()?.removeAllRanges();
    }
    if (drag.active) {
      // Compute strip-relative indicator x in one pass over the wrapper rects —
      // the indicator moves without taking any flex layout space (no shove).
      if (stripRef.current) {
        const stripRect = stripRef.current.getBoundingClientRect();
        const wrappers = stripRef.current.querySelectorAll<HTMLElement>(
          "[data-tab-wrapper]",
        );
        let indX: number | null = null;
        let lastRight = 0;
        for (const wrapper of wrappers) {
          const rect = wrapper.getBoundingClientRect();
          lastRight = rect.right - stripRect.left;
          if (e.clientX < rect.left + rect.width / 2) {
            indX = rect.left - stripRect.left;
            break;
          }
        }
        if (indX === null && wrappers.length > 0) {
          indX = lastRight;
        }
        setDropIndicatorX(indX);
      }
      setDragGhost({
        tabId: drag.tabId,
        title: drag.title,
        x: e.clientX,
        y: e.clientY,
        isActive: drag.isActive,
        isDeleted: drag.isDeleted,
      });
    }
  }

  function handleStripPointerUp(e: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;

    if (drag.active) {
      // Suppress the click that fires immediately after pointerup on a real drag.
      suppressClickRef.current = true;

      const targetId = computeDropTarget(e.clientX);
      setDropIndicatorX(null);
      setDragGhost(null);
      dragRef.current = null;

      // Map the drop onto the VISIBLE strip to a full-array insert index.
      // Hidden (overflowed) tabs can be interleaved between visible ones, so
      // this anchors on the previous VISIBLE tab's full-array position + 1
      // rather than the target's own full-array index (WR-03).
      const toIdx = computeDropIndex({
        tabIds: tabs.map((t) => t.id),
        visibleTabIds: visibleTabs.map((t) => t.id),
        targetId,
      });
      // reorderTabs splices fromIndex OUT before inserting at toIndex
      // (splice-first), so a left-to-right drop must compensate by one to
      // land where the left-edge indicator promised (gap 6 / WR-01).
      const adjusted = drag.fromIndex < toIdx ? toIdx - 1 : toIdx;
      if (toIdx !== -1 && adjusted !== drag.fromIndex) {
        onReorder(drag.fromIndex, adjusted);
      }
    } else {
      setDropIndicatorX(null);
      setDragGhost(null);
      dragRef.current = null;
    }
  }

  function handleStripPointerCancel() {
    dragRef.current = null;
    setDropIndicatorX(null);
    setDragGhost(null);
    // An abandoned/cancelled drag must never leave a later legitimate click
    // suppressed (gap 5 / CR-02).
    suppressClickRef.current = false;
  }

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label="Open tabs"
      style={{
        ...tabStripStyle,
        ...style,
        // Grabbing cursor signals an active drag at the strip level.
        ...(dragGhost !== null ? { cursor: "grabbing" } : {}),
      }}
      data-testid="tab-strip"
      onPointerMove={handleStripPointerMove}
      onPointerUp={handleStripPointerUp}
      onPointerCancel={handleStripPointerCancel}
      onClickCapture={(e) => {
        // Swallow the post-drag click at the strip level so it doesn't also
        // select the tab that was just reordered.
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          e.stopPropagation();
        }
      }}
    >
      {leftCluster}
      {/* Visible tabs in their own flex child so trailing controls always reserve space. */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          flex: "1 1 auto",
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        {visibleTabs.map((tab) => {
          const fromIndex = tabs.findIndex((t) => t.id === tab.id);
          return (
            <div
              key={tab.id}
              data-tab-wrapper={tab.id}
              style={{ display: "flex", alignItems: "flex-end", minWidth: 0 }}
              onPointerDown={(e) => handlePointerDown(tab, fromIndex, e)}
            >
              <TabContextMenu
                onOpenRight={() => onOpenRight(tab.id)}
                onClose={() => onRequestClose(tab.id)}
                onCloseOthers={() => onCloseOthers(tab.id)}
                onCloseToRight={() => onCloseToRight(tab.id)}
              >
                <TabPill
                  title={titleForTab(tab.noteId)}
                  isActive={tab.id === activeTabId}
                  paneActive={isActivePane}
                  isDeleted={deletedTabIds.has(tab.noteId)}
                  isDragging={dragGhost?.tabId === tab.id}
                  onSelect={() => onSelectTab(tab.id)}
                  onClose={() => onRequestClose(tab.id)}
                />
              </TabContextMenu>
            </div>
          );
        })}
      </div>
      {hiddenTabs.length > 0 && (
        <TabOverflowDropdown
          hiddenTabs={hiddenTabs.map((tab) => ({
            id: tab.id,
            title: titleForTab(tab.noteId),
            isActive: tab.id === activeTabId,
          }))}
          onSelectTab={onSelectTab}
        />
      )}
      {newTabButton}
      {rightCluster}
      {/* Single absolute overlay bar at the drop boundary — moves without shifting
          any pill's layout position. zIndex below the fixed ghost (1000). */}
      {dragGhost !== null && dropIndicatorX !== null && (
        <div
          data-testid="tab-drop-indicator"
          aria-hidden="true"
          style={{ ...dropOverlayStyle, left: dropIndicatorX }}
        />
      )}
      {/* Ghost copy of the dragged tab that follows the cursor. position:fixed
          escapes the strip's overflow:hidden; pointerEvents:none keeps mouse
          events reaching the real strip handlers underneath. A real TabPill
          inside the container faithfully shows the X icon, active accent border,
          and deleted state — not a title-only lightweight preview. */}
      {dragGhost !== null && (
        <div
          data-testid="tab-drag-ghost"
          aria-hidden="true"
          style={{
            position: "fixed",
            left: dragGhost.x + 12,
            top: dragGhost.y + 12,
            pointerEvents: "none",
            zIndex: 1000,
            opacity: 0.85,
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
            cursor: "grabbing",
          }}
        >
          <TabPill
            title={dragGhost.title}
            isActive={dragGhost.isActive}
            paneActive={isActivePane}
            isDeleted={dragGhost.isDeleted}
            onSelect={() => {}}
            onClose={() => {}}
          />
        </div>
      )}
    </div>
  );
}
