/**
 * PaneTree — recursive renderer over usePaneStore's layout tree (WS-03/WS-07).
 *
 * `{t:"split"}` nodes lay out two children in a flex container by `dir`
 * ("row" → horizontal, "col" → vertical), sized by `ratio`, with a static 1px
 * divider between them (non-interactive in Phase 25 — drag-resize is Phase
 * 26). `{t:"leaf"}` nodes render one `LeafPane`, marked active by comparing
 * its id against `activePaneId`.
 *
 * This component is intentionally standalone in Phase 25 — wiring it into
 * `App.tsx` (replacing the current singleton TabStrip + stacked-EditorPane
 * composition) is Plan 07's job.
 */
import { usePaneStore } from "../lib/usePaneStore";
import type { PaneNode } from "../lib/paneTree";
import { LeafPane } from "./LeafPane";

export interface PaneTreeProps {
  reindexing: boolean;
  deletedTabIds: Set<string>;
  titleForTab: (noteId: string) => string;
  onRequestClose: (leafId: string, tabId: string) => void;
  onCloseOthers: (leafId: string, tabId: string) => void;
  onCloseToRight: (leafId: string, tabId: string) => void;
  onOpenRight: (leafId: string, tabId: string) => void;
  onNewTab: (leafId: string) => void;
  autosaveMs?: number;
  /** Zen mode (ZEN-01): every leaf's tab strip unmounts; the editor body fills the pane. */
  hideTabStrip?: boolean;
  style?: React.CSSProperties;
}

type NodeRenderProps = Omit<PaneTreeProps, "style">;

function renderNode(
  node: PaneNode,
  activePaneId: string,
  props: NodeRenderProps,
): React.JSX.Element {
  if (node.t === "leaf") {
    return (
      <LeafPane
        key={node.id}
        leaf={node}
        isActive={activePaneId === node.id}
        reindexing={props.reindexing}
        deletedTabIds={props.deletedTabIds}
        titleForTab={props.titleForTab}
        onRequestClose={props.onRequestClose}
        onCloseOthers={props.onCloseOthers}
        onCloseToRight={props.onCloseToRight}
        onOpenRight={props.onOpenRight}
        onNewTab={props.onNewTab}
        autosaveMs={props.autosaveMs}
        hideTabStrip={props.hideTabStrip}
        style={{ flex: 1, minHeight: 0, minWidth: 0 }}
      />
    );
  }

  const isRow = node.dir === "row";
  return (
    <div
      // Intentionally no key: this <div> is the single child returned by
      // renderNode, not a list item, so React reconciles it in place across
      // re-renders. A content-derived key here (e.g. keyed by whether a
      // child is a leaf or a split) would change whenever a child transitions
      // leaf<->split — forcing an unmount+remount of this entire subtree
      // (destroying every descendant pane's CM6 view/cursor/undo, including
      // UNRELATED sibling panes) on every split/collapse. See 25-REVIEW.md CR-01.
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
        {renderNode(node.a, activePaneId, props)}
      </div>
      <div
        data-testid="pane-divider"
        aria-hidden="true"
        style={{
          flexShrink: 0,
          width: isRow ? 1 : "100%",
          height: isRow ? "100%" : 1,
          background: "var(--color-border)",
        }}
      />
      <div
        style={{
          flex: 1 - node.ratio,
          minHeight: 0,
          minWidth: 0,
          display: "flex",
          overflow: "hidden",
        }}
      >
        {renderNode(node.b, activePaneId, props)}
      </div>
    </div>
  );
}

export function PaneTree({ style, ...rest }: PaneTreeProps) {
  const tree = usePaneStore((s) => s.tree);
  const activePaneId = usePaneStore((s) => s.activePaneId);

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
      {renderNode(tree, activePaneId, rest)}
    </div>
  );
}
