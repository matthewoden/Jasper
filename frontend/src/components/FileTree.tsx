/**
 * FileTree — react-arborist <Tree> wrapper + state routing.
 *
 * Branches:
 *   - useFileTree.error           → <TreeErrorState onRetry={refresh} />
 *   - loading + tree==null        → 1px indeterminate progress stripe
 *                                   (re-uses Phase 2's jasper-progress-stripe
 *                                    keyframes from theme.css)
 *   - tree.root.length === 0      → <TreeEmptyState />
 *   - tree.root has children      → <Tree> with adapted data + TreeRow renderer
 *
 * Wire-shape adapter (UI-SPEC §Component Inventory + plan §Wire-shape adapter):
 *   react-arborist requires unique string ids and a stable id+name+children
 *   shape. We:
 *     - prefix folder ids with "folder:" + path
 *     - prefix note ids with "note:" + uuid
 *     - preserve the original wire shape under .data so TreeRow can branch
 *       on data.kind without re-parsing
 *
 * DnD is intentionally disabled this plan (disableDrag + disableDrop). Plan
 * 03-07 turns those off and wires onMove for the actual drag-drop UX.
 *
 * Plan 03-07 will additionally wire:
 *   - context-menu trigger via TreeRow's data-tree-row-kebab + Radix
 *   - onRename for inline-rename
 *   - onMove for drag-drop
 *   - delete confirmation flow
 */
import { useCallback, useMemo } from "react";
import { Tree, type NodeApi } from "react-arborist";

import { useFileTree } from "../lib/useFileTree";
import { useTreeStore } from "../lib/useTreeStore";
import type { Tree as WireTree, TreeNode as WireTreeNode } from "../lib/treeApi";
import { TreeRow, type TreeRowData } from "./TreeRow";
import { TreeEmptyState } from "./TreeEmptyState";
import { TreeErrorState } from "./TreeErrorState";

/**
 * The shape react-arborist actually walks: id is unique across
 * folders+notes via a "folder:" / "note:" prefix; name is the visible
 * label (used by arborist for keyboard search); data preserves the
 * original wire shape so TreeRow can branch on `kind` without
 * re-parsing; children is folder-only (notes are leaves).
 *
 * Exported for direct unit-testing of the adapter.
 */
export interface ArboristNode {
  id: string;
  name: string;
  data: TreeRowData;
  children?: ArboristNode[];
}

/**
 * Convert a wire TreeNode into the shape react-arborist expects, while
 * preserving the original wire shape under `.data` so TreeRow can read
 * `node.data.data` to branch on kind. Exported for direct unit-testing.
 */
export function adaptToArborist(node: WireTreeNode): ArboristNode {
  if (node.kind === "folder") {
    return {
      id: "folder:" + node.path,
      name: node.name,
      data: { kind: "folder", path: node.path, name: node.name },
      children: (node.children ?? []).map(adaptToArborist),
    };
  }
  return {
    id: "note:" + node.id,
    name: node.title,
    data: {
      kind: "note",
      id: node.id,
      path: node.path,
      title: node.title,
    },
  };
}

function adaptTree(wireTree: WireTree): ArboristNode[] {
  return wireTree.root.map(adaptToArborist);
}

export interface FileTreeProps {
  onSelectNote: (id: string) => void;
}

export function FileTree({ onSelectNote }: FileTreeProps) {
  const { tree, loading, error, refresh } = useFileTree();
  const data = useMemo(() => (tree ? adaptTree(tree) : []), [tree]);

  // Compute the initial open-state map ONCE per FileTree mount. After
  // mount, react-arborist owns its own open-state and our zustand store
  // observes `onToggle` to stay in sync. The empty deps array is
  // intentional — re-deriving on every store change would fight
  // arborist's internal state.
  const initialOpenState = useMemo<Record<string, boolean>>(() => {
    const expanded = useTreeStore.getState().expanded;
    const out: Record<string, boolean> = {};
    for (const path of expanded) out["folder:" + path] = true;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggle = useCallback((id: string) => {
    if (id.startsWith("folder:")) {
      const path = id.slice("folder:".length);
      useTreeStore.getState().toggleExpanded(path);
    }
  }, []);

  if (error) return <TreeErrorState onRetry={refresh} />;

  if (loading && !tree) {
    // 1px indeterminate progress stripe at the top of the scroll area —
    // re-uses Phase 2's keyframes from theme.css.
    return (
      <div
        data-testid="tree-loading"
        style={{ position: "relative", height: "100%", overflow: "hidden" }}
      >
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 1,
            background: "var(--color-accent)",
            animation: "jasper-progress-stripe 1.5s linear infinite",
          }}
        />
      </div>
    );
  }

  if (tree && tree.root.length === 0) return <TreeEmptyState />;

  if (!tree) return null;

  return (
    <Tree<ArboristNode>
      data={data}
      idAccessor="id"
      childrenAccessor="children"
      initialOpenState={initialOpenState}
      onToggle={handleToggle}
      rowHeight={32}
      width="100%"
      // arborist requires a numeric height; the flex parent constrains
      // the actual rendered height while internal scroll handles
      // virtualization (PERF-02 — 1,000 nodes).
      height={9999}
      disableDrag // Plan 03-07 turns this off
      disableDrop // Plan 03-07 turns this off
    >
      {(props) => (
        <TreeRow
          // The arborist NodeApi<ArboristNode> exposes node.data.data as
          // the original wire shape (TreeRowData). The inner data is what
          // TreeRow consumes; we narrow the generic by passing through
          // the same NodeApi instance with a typed view of `.data`.
          node={
            new Proxy(props.node, {
              get(target, prop) {
                if (prop === "data") return target.data.data;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const v = (target as any)[prop];
                return typeof v === "function" ? v.bind(target) : v;
              },
            }) as unknown as NodeApi<TreeRowData>
          }
          style={props.style}
          onSelectNote={onSelectNote}
        />
      )}
    </Tree>
  );
}
