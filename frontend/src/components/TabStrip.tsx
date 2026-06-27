/**
 * TabStrip — the editor tab row.
 *
 * Composes the Plan-03 presentational pieces: each ordered tab renders a
 * `TabPill` wrapped in `TabContextMenu`, with a `TabOverflowDropdown` at the
 * right edge listing tabs that don't fit. Reorder is native HTML5 DnD (no
 * library). Capture-phase keyboard shortcuts (Alt+]/Alt+[/Ctrl+Tab cycle,
 * Alt+W close) are registered here (Task 2).
 *
 * Closing ALWAYS routes through `onRequestClose` (flush-aware; App.tsx/Plan 05
 * owns the flush+confirm orchestration) — never `closeTab` directly, so a close
 * can never drop unsaved edits.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import { Plus } from "lucide-react";
import { useTabStore } from "../lib/useTabStore";
import type { Tab } from "../lib/useTabStore";
import { TabPill } from "./TabPill";
import { TabContextMenu } from "./TabContextMenu";
import { TabOverflowDropdown } from "./TabOverflowDropdown";

export interface TabStripProps {
  tabs: Tab[];
  activeTabId: string | null;
  deletedTabIds: Set<string>;
  /** Derived from useFileTree by note UUID (TAB-12 live rename). */
  titleForTab: (noteId: string) => string;
  /** Folder-path prefix by note UUID; shown only on the active, non-deleted pill. */
  breadcrumbForTab?: (noteId: string) => string;
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

export function TabStrip({
  tabs,
  activeTabId,
  deletedTabIds,
  titleForTab,
  breadcrumbForTab,
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
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  // Keyboard shortcuts need the current onRequestClose without re-registering the
  // listener on every render — thread it through a ref kept fresh each render.
  const requestCloseRef = useRef(onRequestClose);
  requestCloseRef.current = onRequestClose;

  // Overflow measurement: tabs whose right edge exceeds the strip's content box
  // are hidden behind the dropdown. Measured after layout; recomputed on resize.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const pillRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Last-measured width per tab. Overflow pills unmount (not in visibleTabs), so
  // their live offsetWidth is unavailable on the next pass; the cache supplies a
  // stable width and keeps the hidden set from oscillating (re-show → re-hide).
  const pillWidths = useRef<Map<string, number>>(new Map());
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
      const available = strip.clientWidth - 8 /* padding */ - 28 /* overflow btn */;
      const next = new Set<string>();
      let used = 0;
      for (const tab of tabs) {
        const el = pillRefs.current.get(tab.id);
        if (el !== undefined) {
          pillWidths.current.set(tab.id, el.offsetWidth);
        }
        const width = pillWidths.current.get(tab.id);
        if (width === undefined) continue; // never measured yet
        used += width;
        if (used > available) next.add(tab.id);
      }
      setMeasuredHiddenIds((prev) =>
        prev.size === next.size && [...prev].every((id) => next.has(id))
          ? prev
          : next,
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [tabs]);

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

  const handleDrop = (targetId: string) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const fromId = e.dataTransfer.getData("tabId");
    setDraggingTabId(null);
    setDropTargetId(null);
    if (fromId === "" || fromId === targetId) return;
    const fromIdx = tabs.findIndex((t) => t.id === fromId);
    const toIdx = tabs.findIndex((t) => t.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    onReorder(fromIdx, toIdx);
  };

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label="Open tabs"
      style={{ ...tabStripStyle, ...style }}
      data-testid="tab-strip"
    >
      {visibleTabs.map((tab) => (
        <div
          key={tab.id}
          ref={(el) => {
            // Register the pill wrapper so the overflow pass can measure its
            // width. Without this, measure() read undefined for every pill and
            // never overflowed (TAB-07). Cleared on unmount.
            if (el === null) pillRefs.current.delete(tab.id);
            else pillRefs.current.set(tab.id, el);
          }}
          style={{ display: "flex", alignItems: "flex-end" }}
        >
          {dropTargetId === tab.id && draggingTabId !== tab.id && (
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
              breadcrumb={
                tab.id === activeTabId && !deletedTabIds.has(tab.noteId)
                  ? breadcrumbForTab?.(tab.noteId)
                  : undefined
              }
              onSelect={() => onSelectTab(tab.id)}
              onClose={() => onRequestClose(tab.id)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("tabId", tab.id);
                e.dataTransfer.effectAllowed = "move";
                setDraggingTabId(tab.id);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dropTargetId !== tab.id) setDropTargetId(tab.id);
              }}
              onDrop={handleDrop(tab.id)}
            />
          </TabContextMenu>
        </div>
      ))}
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
