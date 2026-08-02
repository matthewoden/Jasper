/**
 * TabStrip — a leaf-scoped editor tab row (WS-03: one strip per pane, not a
 * workspace singleton).
 *
 * Composes the presentational pieces: each ordered tab renders a
 * `TabPill` wrapped in `TabContextMenu`, with a `TabOverflowDropdown` always
 * pinned at the right edge listing EVERY open tab, not
 * just the ones the strip's own overflow hid. Reorder uses pointer-event drag
 * (pointerdown on the wrapper → pointermove/pointerup on the strip) because
 * native HTML5 DnD does not deliver drop events reliably in this context.
 * The strip div handles move/up so that setPointerCapture is unnecessary —
 * avoiding Chromium's click-target redirection that captures would cause.
 *
 * Capture-phase keyboard shortcuts (Alt+]/Alt+[/Ctrl+Tab cycle, Alt+W close)
 * are registered here, gated on `usePaneStore.getState().activePaneId ===
 * leafId`: with N leaves mounted, N TabStrips each
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
import { Plus, PanelRight } from "lucide-react";
import { PaneCornerReopenButton } from "./PaneCornerReopenButton";
import { usePaneStore } from "../lib/usePaneStore";
import { usePaneDragStore, type DropRegion } from "../lib/usePaneDragStore";
import { _findLeaf } from "../lib/paneTree";
import type { Tab } from "../lib/useTabStore";
import { useTreeStore } from "../lib/useTreeStore";
import { useToast } from "./toast.utils";
import { useReveal } from "../lib/useReveal";
import { getNote } from "../lib/notesApi";
import { TabPill } from "./TabPill";
import { TabContextMenu } from "./TabContextMenu";
import { TabOverflowDropdown } from "./TabOverflowDropdown";
import { Tooltip } from "./Tooltip";
import {
  computeHiddenTabIds,
  computeDropIndex,
  clampIndexToPinnedBoundary,
  MIN_TAB_WIDTH,
} from "../lib/tabOverflow";

/** Set equality used to preserve state identity (avoid re-render churn). */
function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

// Reserved strip chrome that is never available to tabs:
//   strip horizontal padding (8) + pinned new-tab button (32) + the tab-bar
//   left cluster (37).
//   Left cluster: 28 (left toggle) + 8 (paddingRight) + 1 (borderRight) = 37.
//   New-tab button footprint grew 26→32 in (item 6):
//   newTabButtonStyle's margin went from "0 0 4px 2px" (2px total) to
//   "0 4px" (8px total, L/R padding) when it was re-centered vertically
//   instead of bottom-pinned — 24 (width) + 8 (margin) = 32.
//   RESERVED itself stays a static constant — it does NOT include the
//   right-cluster rail-reopen toggle (260721-cjt), because that toggle is
//   CONDITIONAL (collapsed rail AND rightmost leaf only). Its width
//   (RIGHT_CLUSTER, below) is subtracted dynamically inside the overflow
//   measurement effect only when the toggle actually renders. The overflow
//   dropdown trigger's width (OVERFLOW_BTN, below) is reserved separately —
//   passed straight through to computeHiddenTabIds, which (as of,
//   item 7) now subtracts it UNCONDITIONALLY, since the dropdown trigger
//   itself is always rendered rather than only appearing on overflow.
const LEFT_CLUSTER = 37;
export const RESERVED = 8 + 32 + LEFT_CLUSTER;
// The overflow-dropdown trigger is a square 24x24 hit area
// (TabOverflowDropdown.tsx's triggerButtonStyle) — it was 28x24. Keeping this
// at 28 over-reserved 4px the trigger no longer occupies.
// A "0 4px" L/R margin was later added to the trigger for vertical-centering
// + padding (see TabOverflowDropdown.tsx's triggerButtonStyle comment),
// growing its true horizontal footprint back to 32 (24 + 8 margin) — bumped
// here too so this stays accurate (the same drift this constant exists to
// prevent).
// The trigger this reserves for is ALWAYS
// rendered (not just on overflow) — computeHiddenTabIds subtracts this
// unconditionally as a permanent reservation, not a conditional one.
export const OVERFLOW_BTN = 32;
// Right-cluster rail-reopen toggle width: 1 (borderLeft) + 8 (paddingLeft) +
// 4 (flex gap) + 28 (button) — adapted from the pre-30-13 RightClusterToggle
// (git show e1f59f1d^:frontend/src/components/TabStrip.tsx). Only occupies
// strip width when `showRailToggle` is true (collapsed rail + rightmost leaf).
const RIGHT_CLUSTER = 1 + 8 + 4 + 28;

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
  onCloseAll: () => void;
  onOpenRight: (tabId: string) => void;
  /** Pin/unpin a tab. Threaded through to the tab-menu invocation site and into TabContextMenu's Pin item. */
  onTogglePin: (tabId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  /** Create a new untitled note and open it as a tab (TAB-14, + button / ⌥T). */
  onNewTab: () => void;
  /** Cycle this leaf's active tab (Alt+]/Alt+[/Ctrl+Tab/Ctrl+Shift+Tab) — leaf-scoped, not workspace-wide. */
  onCycleTab: (direction: 1 | -1) => void;
  /** True only for the top-left leaf — hosts the collapsed-sidebar reopen cell. */
  isTopLeftLeaf?: boolean;
  /** True only for the rightmost leaf (pre-order-last) — hosts the collapsed
   *  right-rail reopen toggle when the rail is collapsed (260721-cjt). */
  isRightmostLeaf?: boolean;
  /** Test-only: force a set of tab ids into the overflow dropdown. */
  forceHiddenTabIds?: Set<string>;
  style?: CSSProperties;
}

/** + button styled like SidebarToolbar's icon buttons; pinned at the strip's
 *  right edge (flexShrink:0) so it survives tab overflow. Square 24×24
 *  hit area + rounded hover background (NotesSortMenu.triggerButtonStyle
 *  treatment) — closes the owner's "no hover state" complaint.
 *
 *  The owner also wants L/R breathing room plus
 *  vertical centering in the tab-strip row, aligned on roughly the same axis
 *  as the left-rail/right-rail icon rows (ActivityRibbon / RightRailTabRow —
 *  both center a 16px glyph in a ~30x32px button). `alignSelf:"center"`
 *  overrides the strip's own `alignItems:"flex-end"` (tabStripStyle) so this
 *  button centers in the full 40px row instead of bottom-pinning against the
 *  40px-tall TabPills — this REVERSES the prior bottom-pin contract that
 *  co-centered this button with TabPill's close-× (see
 *  TabPill.tsx's closeButtonStyle comment; that × is now itself centered on
 *  the label instead). `marginLeft`/`marginRight` give the L/R padding the
 *  owner asked for. NOTE: exact cross-region pixel alignment with the rail
 *  icon axis is NOT guaranteed — the tab strip and the rails are different
 *  DOM regions with independent top offsets (same deferral ActivityRibbon's
 *  own comment documents); only the vertical-centering + padding
 *  ask is guaranteed here. */
const newTabButtonStyle: CSSProperties = {
  width: 24,
  height: 24,
  padding: 4,
  margin: "0 4px",
  alignSelf: "center",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
  flexShrink: 0,
};

/** Own hover state so it tints on hover without leaking a hook into TabStrip's
 *  normal render path (same idiom as EmptyStateNewTabButton/RailReopenToggle). */
function NewTabButton({ onNewTab }: { onNewTab: () => void }) {
  const [hovering, setHovering] = useState(false);
  return (
    <Tooltip label="New tab" shortcut="⌥T">
      <button
        type="button"
        aria-label="New tab"
        data-testid="new-tab-button"
        onClick={onNewTab}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        style={{
          ...newTabButtonStyle,
          background: hovering
            ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
            : "transparent",
        }}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/** Empty-state new-tab button: the prior tab-shaped
 *  silhouette (an 80px-wide bordered rectangle meant to read as a real tab)
 *  is what the owner called out as "huge, because of all the left/right
 *  padding" — it ballooned to fill the empty bar instead of reading as a
 *  normal button. Reuses the SAME compact 24×24 icon-button footprint as the
 *  normal add-tab button (`newTabButtonStyle`, below) rather than a bespoke
 *  tab-shaped treatment, so an empty strip shows a normal-sized "+" at the
 *  left instead of a giant one. Own hover state so it tints without leaking
 *  a hook into TabStrip's normal render path. */
function EmptyStateNewTabButton({ onNewTab }: { onNewTab: () => void }) {
  const [hovering, setHovering] = useState(false);
  return (
    <Tooltip label="New tab" shortcut="⌥T">
      <button
        type="button"
        aria-label="New tab"
        data-testid="new-tab-button"
        onClick={onNewTab}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        style={{
          ...newTabButtonStyle,
          background: hovering
            ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
            : "transparent",
        }}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/** 28x28 icon button for the tab-bar right cluster's rail-reopen toggle —
 *  own hover state so it tints like the pre-30-13 RightClusterToggle
 *  (git show e1f59f1d^:frontend/src/components/TabStrip.tsx) without leaking
 *  a hook into TabStrip's normal render path. */
function RailReopenToggle({ onClick }: { onClick: () => void }) {
  const [hovering, setHovering] = useState(false);
  return (
    <Tooltip label="Show panels">
      <button
        type="button"
        aria-label="Show panels"
        onClick={onClick}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        style={{
          width: 28,
          height: 28,
          padding: 6,
          background: hovering
            ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
            : "transparent",
          border: "none",
          color: "var(--color-muted)",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          // radius 6 matches PaneCornerReopenButton's hover tint — the two
          // rail toggles must read as mirror images.
          borderRadius: 6,
        }}
      >
        <PanelRight size={16} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

// No borderBottom (TABUI-01): per-tab right borders + the active top-accent
// carry the separation now. A strip-level bottom border would draw a seam
// across the active tab's --color-bg background, undermining the "seated on
// the editor column below" look that background is meant to convey.
const tabStripStyle: CSSProperties = {
  position: "relative",
  // "the bar needs to be full screen" — an explicit
  // width:100% guarantees the strip spans its pane's full width regardless
  // of parent flex context, rather than relying on an implicit cross-axis
  // stretch that a future layout change could silently drop.
  width: "100%",
  boxSizing: "border-box",
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
  onCloseAll,
  onOpenRight,
  onTogglePin,
  onReorder,
  onNewTab,
  onCycleTab,
  isTopLeftLeaf = false,
  isRightmostLeaf = false,
  forceHiddenTabIds,
  style,
}: TabStripProps) {
  // Pinned tabs refuse a direct pin-glyph click with a toast rather
  // than closing — same toast-on-refusal idiom as useWorkspace.ts/useReveal.ts.
  const { toast } = useToast();
  const handlePinnedClickRefused = () => {
    toast({ title: "This tab is pinned — right-click to unpin" });
  };

  // "Show in file manager" (CTX-01) — the tab menu only has a noteId, not a
  // vault-relative path, so the lookup is a lazy getNote() at click time
  // rather than a mount-time useFileTree() subscription (which would add a
  // second /tree fetcher per open leaf for no render-time benefit).
  const { reveal } = useReveal();
  const handleRevealTab = (noteId: string) => {
    void (async () => {
      const { data } = await getNote(noteId);
      if (data?.path) void reveal(data.path);
    })();
  };

  // "Rename" (CTX-01) — Jasper has no tab-only rename; this reuses the tree's
  // own inline-rename entry point (same one TreeRowMenu's Rename item drives)
  // against the tab's underlying note.
  const handleRenameTab = (noteId: string) => {
    useTreeStore.getState().startRename("note", noteId);
  };

  // Whether THIS strip's leaf is the active pane: the
  // active tab's top-accent reads purple (--color-accent) only in the active
  // pane, and a neutral gray (--color-muted) in inactive panes — so the purple
  // accent itself signals which pane is active. Subscribed (not getState) so
  // the accent flips live when focus moves between panes.
  const isActivePane = usePaneStore((s) => s.activePaneId === leafId);

  // Foreign-strip insertion caret (Obsidian parity): every mounted
  // TabStrip subscribes to usePaneDragStore's stripHover, but only renders
  // the caret when IT is the hovered foreign strip — a SEPARATE render
  // branch from the source strip's own dragGhost/dropIndicatorX indicator
  // below (whose dragGhost/dropIndicatorX are null on a foreign strip), so
  // the two indicators never both fire on the same strip.
  const foreignStripHover = usePaneDragStore((s) => s.stripHover);
  const foreignInsert = foreignStripHover?.leafId === leafId ? foreignStripHover : null;

  // The left sidebar is collapsed from its own header (SidebarTabRow) and
  // reopened via PaneCornerReopenButton — the tab strip no longer carries a
  // redundant left-sidebar toggle (NAV-03; the mock shows a tab-bar left
  // toggle only when the sidebar is closed, never when it's open).
  //
  // The right rail is DIFFERENT: while expanded, its own
  // header owns the sole collapse control — the tab
  // strip carries no toggle. But collapsing the rail now unmounts it
  // entirely (0 width, flush editor) instead of leaving a collapsed strip,
  // so the reopen affordance moves into the tab bar's right cluster —
  // rendered ONLY when the rail is collapsed AND this strip belongs to the
  // rightmost leaf (pre-order-last, mirrors isTopLeftLeaf's approximation
  // for split layouts). Exactly one rail toggle is visible at any time.
  const backlinksRailExpanded = useTreeStore((s) => s.backlinksRailExpanded);
  const setBacklinksRailExpanded = useTreeStore((s) => s.setBacklinksRailExpanded);
  const showRailToggle = !backlinksRailExpanded && isRightmostLeaf;

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
  // Kept fresh so the stable window keydown listener always refuses via the
  // CURRENT toast closure (handlePinnedClickRefused is redefined every render).
  const handlePinnedClickRefusedRef = useRef(handlePinnedClickRefused);
  handlePinnedClickRefusedRef.current = handlePinnedClickRefused;
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
      const available = strip.clientWidth - RESERVED - (showRailToggle ? RIGHT_CLUSTER : 0);
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
  }, [tabs, activeTabId, showRailToggle]);

  // Capture-phase keyboard shortcuts, gated to the ACTIVE pane:
  // every mounted leaf's TabStrip registers this
  // same window listener, so without the guard below N leaves would all act
  // on one keypress. Registered once per leafId; tabs/activeTabId/callbacks
  // are read through refs kept fresh each render so the listener stays stable.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (usePaneStore.getState().activePaneId !== leafId) return;
      if (tabsRef.current.length === 0) return;

      // Alt+W → request close of the active tab (flush-aware via prop).
      // Never bind plain Cmd/Ctrl+W — the browser owns it.
      // A pinned active tab refuses the close (same
      // toast the x-path and middle-click already surface) instead of
      // reaching requestCloseRef — read through tabsRef so the stable window
      // listener always sees the current pin state.
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyW") {
        e.preventDefault();
        e.stopPropagation();
        const activeTab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
        if (activeTab?.pinned === true) {
          handlePinnedClickRefusedRef.current();
          return;
        }
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

  // Cross-pane drag tracking (WS-01/WS-02): once a drag is
  // active, the strip's own onPointerMove/onPointerUp only fire while the
  // cursor is physically over THIS strip's DOM subtree — as soon as it
  // leaves (over another pane's body, another leaf's strip, or this leaf's
  // own body outside the strip), no more React synthetic events reach us.
  // These WINDOW-level listeners pick up the slack: pointermove keeps the
  // reused ghost pill tracking the cursor and hit-tests
  // `elementFromPoint` against `[data-droppane]` (LeafPane root) to publish
  // the hovered region to usePaneDragStore; pointerup
  // routes the drop. Native window listeners bubble AFTER React's delegated
  // handlers reach the root container, so when a release lands back inside
  // THIS strip, handleStripPointerUp already clears dragRef.current before
  // this window handler runs — naturally preserving the in-strip reorder
  // path (computeDropTarget) without any leaf-id bookkeeping here.
  useEffect(() => {
    function handleWindowPointerMove(e: globalThis.PointerEvent) {
      const drag = dragRef.current;
      if (drag === null) return;
      if (!drag.active) {
        if (Math.abs(e.clientX - drag.startX) <= DRAG_THRESHOLD) return;
        drag.active = true;
        window.getSelection()?.removeAllRanges();
        usePaneDragStore.getState().beginDrag(leafId, drag.tabId);
      }
      setDragGhost({
        tabId: drag.tabId,
        title: drag.title,
        x: e.clientX,
        y: e.clientY,
        isActive: drag.isActive,
        isDeleted: drag.isDeleted,
      });

      // jsdom (unit tests) does not implement elementFromPoint — real browsers
      // (and the E2E Playwright suite, Task 3) always do. Feature-detect so
      // the drag lifecycle degrades to "no cross-pane hover" instead of
      // throwing under test.
      const hit =
        typeof document.elementFromPoint === "function"
          ? document.elementFromPoint(e.clientX, e.clientY)
          : null;
      const paneEl = hit?.closest("[data-droppane]") as HTMLElement | null;
      const targetLeafId = paneEl?.dataset.droppane;
      // Suppress the split/move hover while the cursor is over a tab strip
      // every strip lives inside its own pane's `[data-droppane]`
      // subtree, so an ordinary in-strip reorder (cursor near the top of the
      // pane) would otherwise hit-test as a bogus "top" split on the pane the
      // user never left. Dragging into a pane *body* — including the drag's
      // own pane — is a genuine split/move target (WS-01/WS-02) and still
      // publishes, so a solo pane can be split by dragging its own tab out.
      const overStrip = hit?.closest('[data-testid="tab-strip"]') != null;
      if (overStrip && targetLeafId && targetLeafId !== leafId) {
        // Foreign-strip positional insert (Obsidian parity): compute the
        // insertion index/x from the FOREIGN strip's own visible pill rects
        // — never from this (source) strip's data. Same-pane strip hover
        // (targetLeafId === leafId) intentionally falls through to the final
        // `else` below: that is the in-strip reorder path's own territory
        // (no bogus split/insert overlay on the pane never left).
        const foreignStripEl = hit!.closest(
          '[data-testid="tab-strip"]',
        ) as HTMLElement;
        const stripRect = foreignStripEl.getBoundingClientRect();
        const wrappers = foreignStripEl.querySelectorAll<HTMLElement>(
          "[data-tab-wrapper]",
        );
        const visibleIds: string[] = [];
        let targetId: string | null = null;
        let indicatorX = 0;
        let lastRight = 0;
        let found = false;
        for (const wrapper of wrappers) {
          const id = wrapper.dataset.tabWrapper ?? "";
          visibleIds.push(id);
          if (found) continue;
          const rect = wrapper.getBoundingClientRect();
          lastRight = rect.right - stripRect.left;
          if (e.clientX < rect.left + rect.width / 2) {
            targetId = id || null;
            indicatorX = rect.left - stripRect.left;
            found = true;
          }
        }
        if (!found) indicatorX = lastRight;

        const foreignLeaf = _findLeaf(usePaneStore.getState().tree, targetLeafId);
        const rawIndex = foreignLeaf
          ? computeDropIndex({
              tabIds: foreignLeaf.tabs.map((t) => t.id),
              visibleTabIds: visibleIds,
              targetId,
            })
          : -1;
        // An unpinned dragged tab can never land inside the
        // FOREIGN leaf's pinned region, and a pinned dragged tab can never
        // land outside it — pinnedCount counts the foreign leaf's OWN pinned
        // tabs (the dragged tab is not yet a member of it). This effect only
        // re-registers on [leafId] (below), so read the source tab's pinned
        // flag through tabsRef (kept fresh every render) rather than closing
        // over the `tabs` prop directly — a raw closure would go stale.
        const draggedIsPinned = tabsRef.current.find((t) => t.id === drag.tabId)?.pinned === true;
        const pinnedCount = foreignLeaf
          ? foreignLeaf.tabs.filter((t) => t.pinned).length
          : 0;
        const index = clampIndexToPinnedBoundary(rawIndex, pinnedCount, draggedIsPinned);
        if (index !== -1) {
          usePaneDragStore.getState().setStripHover({ leafId: targetLeafId, index, indicatorX });
        } else {
          usePaneDragStore.getState().setStripHover(null);
        }
        usePaneDragStore.getState().setHover(null);
      } else if (paneEl && targetLeafId && !overStrip) {
        const rect = paneEl.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width;
        const py = (e.clientY - rect.top) / rect.height;
        let region: DropRegion;
        if (px < 0.22) region = "left";
        else if (px > 0.78) region = "right";
        else if (py < 0.22) region = "top";
        else if (py > 0.78) region = "bottom";
        else region = "center";
        usePaneDragStore.getState().setHover({ leafId: targetLeafId, region });
        usePaneDragStore.getState().setStripHover(null);
      } else {
        usePaneDragStore.getState().setHover(null);
        usePaneDragStore.getState().setStripHover(null);
      }
    }

    function handleWindowPointerUp() {
      const drag = dragRef.current;
      if (drag === null) return;
      if (drag.active) {
        const { hover, stripHover } = usePaneDragStore.getState();
        if (stripHover !== null) {
          usePaneStore
            .getState()
            .dropTabAtIndex(leafId, drag.tabId, stripHover.leafId, stripHover.index);
        } else if (hover !== null) {
          usePaneStore.getState().dropTabOnPane(leafId, drag.tabId, hover.leafId, hover.region);
        }
      }
      dragRef.current = null;
      setDropIndicatorX(null);
      setDragGhost(null);
      suppressClickRef.current = false;
      usePaneDragStore.getState().endDrag();
    }

    // Focus loss mid-drag is always an abandon — never route a drop.
    function handleWindowBlur() {
      if (dragRef.current === null) return;
      dragRef.current = null;
      setDropIndicatorX(null);
      setDragGhost(null);
      suppressClickRef.current = false;
      usePaneDragStore.getState().endDrag();
    }

    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [leafId]);

  // Rail-reopen toggle (260721-cjt): shown ONLY when the right rail is
  // collapsed AND this strip belongs to the rightmost leaf (showRailToggle,
  // computed above). Uses the same PanelRight glyph as RightRailTabRow's
  // collapse control so collapse/reopen read as one affordance toggling
  // state. Adapted from the pre-30-13 RightClusterToggle (see RIGHT_CLUSTER
  // comment above).
  const rightCluster = showRailToggle ? (
    <div
      style={{
        display: "flex",
        // Stretch + center mirrors PaneCornerReopenButton's counter to the
        // strip's alignItems:"flex-end" — without it the 28px toggle seats at
        // the strip bottom and sits visibly lower than the left rail's glyph.
        alignSelf: "stretch",
        alignItems: "center",
        gap: 4,
        borderLeft: "1px solid var(--color-border-inner)",
        paddingLeft: 8,
        flexShrink: 0,
      }}
      data-testid="tab-strip-right-cluster"
    >
      <RailReopenToggle onClick={() => setBacklinksRailExpanded(true)} />
    </div>
  ) : null;

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
        {isTopLeftLeaf && <PaneCornerReopenButton />}
        <EmptyStateNewTabButton onNewTab={onNewTab} />
        <div style={{ flex: "1 1 auto" }} />
        {/* (item 7): the tab-list dropdown is always rendered,
            pinned right, even with zero open tabs (its menu is simply empty). */}
        <TabOverflowDropdown tabs={[]} onSelectTab={onSelectTab} />
        {rightCluster}
      </div>
    );
  }

  const hiddenIds = forceHiddenTabIds ?? measuredHiddenIds;
  const visibleTabs = tabs.filter((t) => !hiddenIds.has(t.id));

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
      // React's delegated pointermove handler (this one) always runs BEFORE
      // the window-level native listener below reaches `window` in the
      // bubble phase — so when threshold-crossing happens while the cursor
      // is still over the strip, THIS branch wins the race to flip
      // drag.active. Call beginDrag here too (idempotent — both sites are
      // guarded by the same `!drag.active` check) so usePaneDragStore is
      // always populated, not just when the window listener wins.
      usePaneDragStore.getState().beginDrag(leafId, drag.tabId);
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
      // rather than the target's own full-array index.
      const toIdx = computeDropIndex({
        tabIds: tabs.map((t) => t.id),
        visibleTabIds: visibleTabs.map((t) => t.id),
        targetId,
      });
      // reorderTabs splices fromIndex OUT before inserting at toIndex
      // (splice-first), so a left-to-right drop must compensate by one to
      // land where the left-edge indicator promised.
      const adjusted = drag.fromIndex < toIdx ? toIdx - 1 : toIdx;
      // `adjusted` is already an index into the array with the
      // dragged tab spliced OUT, so pinnedCount (this leaf's OTHER pinned
      // tabs) clamps it directly — an unpinned tab can never land inside the
      // pinned region, a pinned tab can never land outside it.
      const draggedIsPinned = tabs.find((t) => t.id === drag.tabId)?.pinned === true;
      const pinnedCount = tabs.filter((t) => t.pinned && t.id !== drag.tabId).length;
      const clampedAdjusted = clampIndexToPinnedBoundary(adjusted, pinnedCount, draggedIsPinned);
      if (toIdx !== -1 && clampedAdjusted !== drag.fromIndex) {
        onReorder(drag.fromIndex, clampedAdjusted);
      }
    } else {
      setDropIndicatorX(null);
      setDragGhost(null);
      dragRef.current = null;
    }
    usePaneDragStore.getState().endDrag();
  }

  function handleStripPointerCancel() {
    dragRef.current = null;
    setDropIndicatorX(null);
    setDragGhost(null);
    // An abandoned/cancelled drag must never leave a later legitimate click
    // suppressed.
    suppressClickRef.current = false;
    usePaneDragStore.getState().endDrag();
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
      {isTopLeftLeaf && <PaneCornerReopenButton />}
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
                onCloseAll={() => onCloseAll()}
                onOpenSplit={() =>
                  usePaneStore.getState().openNoteInNewSplit(tab.noteId, "row")
                }
                isPinned={tab.pinned === true}
                onTogglePin={() => onTogglePin(tab.id)}
                onRename={() => handleRenameTab(tab.noteId)}
                onReveal={() => handleRevealTab(tab.noteId)}
              >
                <TabPill
                  title={titleForTab(tab.noteId)}
                  isActive={tab.id === activeTabId}
                  paneActive={isActivePane}
                  isDeleted={deletedTabIds.has(tab.noteId)}
                  isDragging={dragGhost?.tabId === tab.id}
                  isPinned={tab.pinned === true}
                  onSelect={() => onSelectTab(tab.id)}
                  onClose={() => onRequestClose(tab.id)}
                  onPinnedClickRefused={handlePinnedClickRefused}
                />
              </TabContextMenu>
            </div>
          );
        })}
      </div>
      {/* (item 7): always rendered (not gated on hiddenTabs.length),
          pinned right, and lists EVERY open tab — not just the ones
          overflow-hidden from the pill row above. */}
      <TabOverflowDropdown
        tabs={tabs.map((tab) => ({
          id: tab.id,
          title: titleForTab(tab.noteId),
          isActive: tab.id === activeTabId,
        }))}
        onSelectTab={onSelectTab}
      />
      <NewTabButton onNewTab={onNewTab} />
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
      {/* Foreign-strip insertion caret (Obsidian parity): renders on a
          DIFFERENT strip than the one being dragged from — dragGhost/
          dropIndicatorX are null here, so this never doubles up with the
          source strip's own indicator above. */}
      {foreignInsert !== null && (
        <div
          data-testid="tab-drop-indicator"
          aria-hidden="true"
          style={{ ...dropOverlayStyle, left: foreignInsert.indicatorX }}
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
