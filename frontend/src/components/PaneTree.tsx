/**
 * PaneTree — recursive renderer over usePaneStore's layout tree (WS-03/WS-07).
 *
 * `{t:"split"}` nodes lay out two children in a flex container by `dir`
 * ("row" → horizontal, "col" → vertical), sized by `ratio`, with a divider
 * between them. The divider keeps a 1px visual line but carries an
 * interactive ~8px invisible grab zone: pointer-drag resizes the split live
 * (WS-05). `{t:"leaf"}` nodes render one `LeafPane`, marked active by
 * comparing its id against `activePaneId`.
 */
import { useRef, useState } from "react";

import { usePaneStore } from "../lib/usePaneStore";
import { _leaves, type PaneNode, type SplitNode } from "../lib/paneTree";
import { LeafPane } from "./LeafPane";

export interface PaneTreeProps {
  reindexing: boolean;
  deletedTabIds: Set<string>;
  titleForTab: (noteId: string) => string;
  onRequestClose: (leafId: string, tabId: string) => void;
  onCloseOthers: (leafId: string, tabId: string) => void;
  onCloseToRight: (leafId: string, tabId: string) => void;
  onCloseAll: (leafId: string) => void;
  onOpenRight: (leafId: string, tabId: string) => void;
  /** Pin/unpin a tab. Threaded to the tab-menu invocation site. */
  onTogglePin: (leafId: string, tabId: string) => void;
  onNewTab: (leafId: string) => void;
  autosaveMs?: number;
  /** Zen mode (ZEN-01): every leaf's tab strip unmounts; the editor body fills the pane. */
  hideTabStrip?: boolean;
  style?: React.CSSProperties;
}

type NodeRenderProps = Omit<PaneTreeProps, "style">;

/** Minimum pane size (px) a divider drag will clamp the ratio to. */
const MIN_PANE_PX = 160;

interface DividerDragState {
  path: ("a" | "b")[];
  containerRect: DOMRect;
}

/**
 * PaneDivider — the interactive divider between a split's two children
 * Keeps the 1px visual seam intact but overlays an
 * invisible ~8px hit zone (centered on the line) with the correct resize
 * cursor. Pointer-drag mirrors TabStrip's ref-based lifecycle, but tracks
 * via WINDOW-level move/up (not container-level) — a fast drag routinely
 * leaves the narrow hit zone. Pointer capture is deliberately NOT used,
 * matching the project's DnD convention. Live ratio writes flow straight
 * into usePaneStore's
 * setPaneRatio; persistence rides the existing debounced per-vault
 * subscribe — no new persistence code here.
 */
function PaneDivider({
  isRow,
  path,
  ratio,
  containerRef,
}: {
  isRow: boolean;
  path: ("a" | "b")[];
  /** The split node's current ratio (0-1) — surfaced as aria-valuenow. */
  ratio: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DividerDragState | null>(null);

  function handlePointerMove(e: PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const { containerRect } = drag;
    const size = isRow ? containerRect.width : containerRect.height;

    // Guard: too small to honor a 160px minimum on both sides — pin center.
    let clamped = 0.5;
    if (size >= MIN_PANE_PX * 2) {
      const fraction = isRow
        ? (e.clientX - containerRect.left) / containerRect.width
        : (e.clientY - containerRect.top) / containerRect.height;
      const minR = MIN_PANE_PX / size;
      const maxR = 1 - MIN_PANE_PX / size;
      clamped = Math.min(maxR, Math.max(minR, fraction));
    }
    usePaneStore.getState().setPaneRatio(drag.path, clamped);
  }

  function handlePointerUp() {
    dragRef.current = null;
    setDragging(false);
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
    window.removeEventListener("blur", handlePointerUp);
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Only the primary button initiates a resize drag.
    if (e.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;
    dragRef.current = {
      path,
      containerRect: container.getBoundingClientRect(),
    };
    // Mirrors TabStrip's tab-drag pattern
    // (TabStrip.tsx:468,634) — a divider drag has no threshold step (it goes
    // straight to dragging), so clear any accumulated text selection right
    // here instead, before the drag can fight the browser's native
    // drag-to-select over adjacent editor content.
    window.getSelection()?.removeAllRanges();
    setDragging(true);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    // A drag that ends outside the window (e.g. alt-tab mid-drag) must never
    // strand the listeners or leave the tint applied.
    window.addEventListener("blur", handlePointerUp);
  }

  return (
    <div
      data-testid="pane-divider"
      style={{
        position: "relative",
        flexShrink: 0,
        width: isRow ? 1 : "100%",
        height: isRow ? "100%" : 1,
        background: dragging
          ? "color-mix(in srgb, var(--color-accent) 30%, var(--color-border))"
          : "var(--color-border)",
      }}
    >
      {/*
       * Expose the divider to assistive tech as a separator with its current
       * split proportion. Deliberately NOT
       * `tabIndex`/`onKeyDown` — resize is pointer-drag only, and
       * WAI-ARIA's "focusable separator" pattern requires arrow-key support,
       * so making this focusable without it would be a worse a11y experience
       * (a dead tab stop) than leaving it out of the tab order entirely.
       * `role="separator"` + `aria-valuenow` are still announced by a screen
       * reader's browse-mode virtual cursor without requiring focus.
       */}
      <div
        data-testid="pane-divider-handle"
        role="separator"
        aria-orientation={isRow ? "vertical" : "horizontal"}
        aria-label={isRow ? "Resize columns" : "Resize rows"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        onPointerDown={handlePointerDown}
        style={{
          position: "absolute",
          zIndex: 2,
          background: "transparent",
          cursor: isRow ? "col-resize" : "row-resize",
          ...(isRow
            ? { top: 0, height: "100%", left: -3.5, width: 8 }
            : { left: 0, width: "100%", top: -3.5, height: 8 }),
        }}
      />
    </div>
  );
}

/**
 * SplitRenderer — owns the flex container for one split node so its
 * `containerRef` (used by `PaneDivider` to measure the drag axis) has a
 * stable per-node identity across re-renders (a plain function cannot hold a
 * ref). Renders exactly the same DOM shape the original inline `<div>`
 * produced; wrapping it in a component does not add a key anywhere, so the
 * no-remount invariant is unaffected — see the header
 * comment on the returned `<div>` below.
 */
function SplitRenderer({
  node,
  path,
  activePaneId,
  multi,
  props,
  topLeftLeafId,
  rightmostLeafId,
}: {
  node: SplitNode;
  path: ("a" | "b")[];
  activePaneId: string;
  /** Whether the layout has more than one leaf — threaded to LeafPane's active-pane inset cue. */
  multi: boolean;
  props: NodeRenderProps;
  /** The pre-order-first leaf id — threaded down so only that leaf hosts PaneCornerReopenButton. */
  topLeftLeafId: string;
  /** The pre-order-last leaf id (260721-cjt) — threaded down so only that leaf hosts the collapsed right-rail reopen toggle. */
  rightmostLeafId: string;
}) {
  const isRow = node.dir === "row";
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={containerRef}
      // Intentionally no key: this <div> is the single child returned by
      // renderNode/SplitRenderer, not a list item, so React reconciles it in
      // place across re-renders. A content-derived key here (e.g. keyed by
      // whether a child is a leaf or a split) would change whenever a child
      // transitions leaf<->split — forcing an unmount+remount of this entire
      // subtree (destroying every descendant pane's CM6 view/cursor/undo,
      // including UNRELATED sibling panes) on every split/collapse/resize.
      style={{
        display: "flex",
        flexDirection: isRow ? "row" : "column",
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        height: "100%",
        width: "100%",
      }}
    >
      <div
        style={{
          flex: node.ratio,
          minHeight: 0,
          minWidth: 0,
          display: "flex",
          overflow: "hidden",
        }}
      >
        {renderNode(node.a, activePaneId, multi, props, topLeftLeafId, rightmostLeafId, [
          ...path,
          "a",
        ])}
      </div>
      <PaneDivider isRow={isRow} path={path} ratio={node.ratio} containerRef={containerRef} />
      <div
        style={{
          flex: 1 - node.ratio,
          minHeight: 0,
          minWidth: 0,
          display: "flex",
          overflow: "hidden",
        }}
      >
        {renderNode(node.b, activePaneId, multi, props, topLeftLeafId, rightmostLeafId, [
          ...path,
          "b",
        ])}
      </div>
    </div>
  );
}

function renderNode(
  node: PaneNode,
  activePaneId: string,
  multi: boolean,
  props: NodeRenderProps,
  topLeftLeafId: string,
  rightmostLeafId: string,
  path: ("a" | "b")[] = [],
): React.JSX.Element {
  if (node.t === "leaf") {
    return (
      // The collapsed-sidebar reopen affordance now lives IN the top-left
      // leaf's tab strip (isTopLeftLeaf → TabStrip → PaneCornerReopenButton),
      // so it reserves space beside the tabs instead of floating over them.
      <div
        key={node.id}
        style={{ position: "relative", display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}
      >
        <LeafPane
          leaf={node}
          isActive={activePaneId === node.id}
          multi={multi}
          reindexing={props.reindexing}
          deletedTabIds={props.deletedTabIds}
          titleForTab={props.titleForTab}
          onRequestClose={props.onRequestClose}
          onCloseOthers={props.onCloseOthers}
          onCloseToRight={props.onCloseToRight}
          onCloseAll={props.onCloseAll}
          onOpenRight={props.onOpenRight}
          onTogglePin={props.onTogglePin}
          onNewTab={props.onNewTab}
          autosaveMs={props.autosaveMs}
          hideTabStrip={props.hideTabStrip}
          isTopLeftLeaf={node.id === topLeftLeafId}
          isRightmostLeaf={node.id === rightmostLeafId}
          style={{ flex: 1, minHeight: 0, minWidth: 0 }}
        />
      </div>
    );
  }

  return (
    <SplitRenderer
      node={node}
      path={path}
      activePaneId={activePaneId}
      multi={multi}
      props={props}
      topLeftLeafId={topLeftLeafId}
      rightmostLeafId={rightmostLeafId}
    />
  );
}

export function PaneTree({ style, ...rest }: PaneTreeProps) {
  const tree = usePaneStore((s) => s.tree);
  const activePaneId = usePaneStore((s) => s.activePaneId);
  // The pre-order-first leaf is "top-left" — reuse usePaneStore's own
  // leaf ordering (_leaves) rather than inventing a geometry calc.
  const leaves = _leaves(tree);
  const topLeftLeafId = leaves[0]?.id ?? "";
  // 260721-cjt: the pre-order-last leaf is "rightmost" — same approximation
  // topLeftLeafId already uses (accepted by the owner as "complicated with
  // multiple panels"); guarantees exactly one leaf hosts the collapsed
  // right-rail reopen toggle.
  const rightmostLeafId = leaves[leaves.length - 1]?.id ?? "";
  // Whether the layout has more than one leaf — gates LeafPane's
  // active-pane inset accent cue off single-pane layouts (nothing to
  // disambiguate with only one pane).
  const multi = leaves.length > 1;

  return (
    <div
      data-testid="pane-tree"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        height: "100%",
        width: "100%",
        ...style,
      }}
    >
      {renderNode(tree, activePaneId, multi, rest, topLeftLeafId, rightmostLeafId)}
    </div>
  );
}
