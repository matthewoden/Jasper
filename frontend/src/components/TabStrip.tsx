/**
 * TabStrip — the editor tab row.
 *
 * Composes the Plan-03 presentational pieces: each ordered tab renders a
 * `TabPill` wrapped in `TabContextMenu`, with a `TabOverflowDropdown` at the
 * right edge listing tabs that don't fit. Reorder uses pointer-event drag
 * (pointerdown on the wrapper → pointermove/pointerup on the strip) because
 * native HTML5 DnD does not deliver drop events reliably in this context.
 * The strip div handles move/up so that setPointerCapture is unnecessary —
 * avoiding Chromium's click-target redirection that captures would cause.
 * Capture-phase keyboard shortcuts (Alt+]/Alt+[/Ctrl+Tab cycle, Alt+W close)
 * are registered here.
 *
 * Closing ALWAYS routes through `onRequestClose` (flush-aware; App.tsx/Plan 05
 * owns the flush+confirm orchestration) — never `closeTab` directly, so a close
 * can never drop unsaved edits.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { Plus } from "lucide-react";
import { useTabStore } from "../lib/useTabStore";
import type { Tab } from "../lib/useTabStore";
import { TabPill } from "./TabPill";
import { TabContextMenu } from "./TabContextMenu";
import { TabOverflowDropdown } from "./TabOverflowDropdown";
import { computeHiddenTabIds, MIN_TAB_WIDTH } from "../lib/tabOverflow";

/** Set equality used to preserve state identity (avoid re-render churn). */
function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

// Reserved strip chrome that is never available to tabs:
//   strip horizontal padding (4px each side) + the pinned new-tab button
//   (width 24 + 2px left margin). The overflow dropdown trigger (28px) is
//   reserved separately, inside computeHiddenTabIds, ONLY when overflow occurs.
const RESERVED = 8 + 26;
const OVERFLOW_BTN = 28;

// Movement threshold (px) before a pointerdown is treated as a drag.
// Small enough to feel responsive; large enough to not fire on a click.
const DRAG_THRESHOLD = 5;

export interface TabStripProps {
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
 *  silhouette (TabPill's 32px top-rounded pill seated on the 36px strip) rather
 *  than a bare icon, so the empty state still looks like a tab row. */
const emptyStateNewTabButtonStyle: CSSProperties = {
  height: 32,
  minWidth: 80,
  padding: "0 8px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--color-border)",
  borderRadius: "4px 4px 0 0",
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

const tabStripStyle: CSSProperties = {
  height: 36,
  background: "var(--color-bg)",
  borderBottom: "1px solid var(--color-border)",
  padding: "0 4px",
  display: "flex",
  alignItems: "flex-end",
  gap: 0,
  overflow: "hidden",
  flexShrink: 0,
};

/** 2px accent insertion indicator shown at the boundary the drop will land on. */
const dropIndicatorStyle: CSSProperties = {
  width: 2,
  alignSelf: "stretch",
  background: "var(--color-accent)",
  flexShrink: 0,
};

/** State tracked across the pointer-drag lifecycle (mutable ref, not state). */
interface DragRef {
  tabId: string;
  fromIndex: number;
  startX: number;
  active: boolean;
}

export function TabStrip({
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
  forceHiddenTabIds,
  style,
}: TabStripProps) {
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  // Pointer drag state — mutable ref avoids triggering re-renders mid-drag.
  const dragRef = useRef<DragRef | null>(null);
  // After a real drag the pointerup triggers a click on the same element;
  // this ref suppresses that click so selection does not fire post-drag.
  const suppressClickRef = useRef(false);

  // Keyboard shortcuts need the current onRequestClose without re-registering the
  // listener on every render — thread it through a ref kept fresh each render.
  const requestCloseRef = useRef(onRequestClose);
  requestCloseRef.current = onRequestClose;

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

  // Capture-phase keyboard shortcuts (D-13). Registered once; the listener reads
  // live store state via getState() and onRequestClose via a ref so it stays stable.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const store = useTabStore.getState();
      if (store.tabs.length === 0) return;

      // Alt+W → request close of the active tab (flush-aware via prop).
      // Never bind plain Cmd/Ctrl+W — the browser owns it.
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        e.stopPropagation();
        if (store.activeTabId !== null) requestCloseRef.current(store.activeTabId);
        return;
      }

      // Next: Alt+] OR Ctrl+Tab (no shift).
      const isNextAlt = e.altKey && !e.metaKey && !e.ctrlKey && e.key === "]";
      const isNextCtrlTab =
        e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab" && !e.shiftKey;
      if (isNextAlt || isNextCtrlTab) {
        if (isNextCtrlTab) {
          // Ctrl+Tab may be non-cancelable (browser-swallowed) — guard (Pitfall 8).
          try {
            e.preventDefault();
          } catch {
            /* event not cancelable — browser owns Ctrl+Tab here */
          }
        } else {
          e.preventDefault();
        }
        store.cycleTab(1);
        return;
      }

      // Prev: Alt+[ OR Ctrl+Shift+Tab.
      const isPrevAlt = e.altKey && !e.metaKey && !e.ctrlKey && e.key === "[";
      const isPrevCtrlTab =
        e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab" && e.shiftKey;
      if (isPrevAlt || isPrevCtrlTab) {
        if (isPrevCtrlTab) {
          try {
            e.preventDefault();
          } catch {
            /* event not cancelable — browser owns Ctrl+Shift+Tab here */
          }
        } else {
          e.preventDefault();
        }
        store.cycleTab(-1);
        return;
      }
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
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
        <EmptyStateNewTabButton onNewTab={onNewTab} />
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
    };
  }

  // Strip-level pointer handlers: the strip div is large enough to cover all pill
  // wrappers, so we get move/up events without needing setPointerCapture on each
  // wrapper (avoiding Chromium's click-target redirection that capture would cause).
  function handleStripPointerMove(e: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const moved = Math.abs(e.clientX - drag.startX);
    if (!drag.active && moved > DRAG_THRESHOLD) {
      drag.active = true;
    }
    if (drag.active) {
      const target = computeDropTarget(e.clientX);
      setDropTargetId(target);
    }
  }

  function handleStripPointerUp(e: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;

    if (drag.active) {
      // Suppress the click that fires immediately after pointerup on a real drag.
      suppressClickRef.current = true;

      const targetId = computeDropTarget(e.clientX);
      setDropTargetId(null);
      dragRef.current = null;

      if (targetId !== null) {
        const toIdx = tabs.findIndex((t) => t.id === targetId);
        if (toIdx !== -1 && toIdx !== drag.fromIndex) {
          onReorder(drag.fromIndex, toIdx);
        }
      } else {
        // Dropped past all visible tabs — move to end of visible range.
        const lastVisibleIdx = tabs.findIndex(
          (t) => t.id === visibleTabs[visibleTabs.length - 1]?.id,
        );
        if (lastVisibleIdx !== -1 && lastVisibleIdx !== drag.fromIndex) {
          onReorder(drag.fromIndex, lastVisibleIdx);
        }
      }
    } else {
      dragRef.current = null;
    }
  }

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label="Open tabs"
      style={{ ...tabStripStyle, ...style }}
      data-testid="tab-strip"
      onPointerMove={handleStripPointerMove}
      onPointerUp={handleStripPointerUp}
      onClickCapture={(e) => {
        // Swallow the post-drag click at the strip level so it doesn't also
        // select the tab that was just reordered.
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          e.stopPropagation();
        }
      }}
    >
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
              {dropTargetId === tab.id && (
                <div style={dropIndicatorStyle} aria-hidden="true" />
              )}
              <TabContextMenu
                onOpenRight={() => onOpenRight(tab.id)}
                onClose={() => onRequestClose(tab.id)}
                onCloseOthers={() => onCloseOthers(tab.id)}
                onCloseToRight={() => onCloseToRight(tab.id)}
              >
                <TabPill
                  title={titleForTab(tab.noteId)}
                  isActive={tab.id === activeTabId}
                  isDeleted={deletedTabIds.has(tab.noteId)}
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
    </div>
  );
}
