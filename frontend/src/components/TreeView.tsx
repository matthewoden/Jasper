/**
 * TreeView — generic react-arborist <Tree> host shared by FileTree (notes)
 * and BookmarksPanel (bookmarks). Owns exactly the parts of the tree
 * surface that are data-source-agnostic:
 *   - the <Tree> element itself (idAccessor/childrenAccessor/rowHeight/
 *     width/openByDefault wiring, all locked identical across both panels)
 *   - the `.data.data`-unwrapping Proxy that lets row renderers branch on
 *     TreeRowData without re-parsing react-arborist's node shape
 *   - ResizeObserver-driven height measurement (a fixed `height` prop is
 *     required by react-window; this fills the parent's available space)
 *   - initialOpenState / onToggle plumbing
 *
 * This file has NO knowledge of notes or bookmarks specifically — no
 * useFileTree, useTreeMutations, useBookmarks, or notes/bookmarks API
 * imports. Callers supply data + handlers + a renderRow render-prop
 * configured with their own TreeRow wiring (note handlers vs bookmark
 * handlers). FileTree.tsx and BookmarksPanel.tsx are both thin wrappers
 * around this component (quick task 260719-jv1, item 5).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Tree, type NodeApi, type TreeApi } from "react-arborist";

import type { TreeRowData } from "./TreeRow";

/**
 * Minimal shape react-arborist needs to walk a tree: a stable id, a
 * visible name (used by arborist for keyboard search), the original
 * data payload TreeRow branches on, and optional children. Both
 * fileTree.utils.ts's ArboristNode and bookmarkTree.utils.ts's node
 * shape satisfy this structurally — no import needed either direction.
 */
export interface TreeViewNode {
  id: string;
  name: string;
  data: TreeRowData;
  children?: TreeViewNode[];
}

export interface TreeViewRenderRowProps<T extends TreeViewNode> {
  /** `.data` unwrapped to the raw TreeRowData — pass straight into TreeRow. */
  node: NodeApi<TreeRowData>;
  /** The original (non-unwrapped) react-arborist node, for callers that need
   *  tree structure (parent/children) beyond what TreeRow itself uses —
   *  e.g. FileTree's siblingNamesFor. */
  rawNode: NodeApi<T>;
  style: CSSProperties;
  dragHandle?: (el: HTMLDivElement | null) => void;
}

export interface TreeViewProps<T extends TreeViewNode> {
  data: T[];
  treeRef: RefObject<TreeApi<T> | null>;
  initialOpenState?: Record<string, boolean>;
  /**
   * Default open state for a node NOT covered by initialOpenState (e.g. one
   * created after mount). Defaults to false, matching FileTree's Notes
   * behavior (folders start collapsed, tracked in useTreeStore.expanded).
   * BookmarksPanel passes true — bookmark folders have always started
   * expanded by default (pre-existing UX), and there's no persisted
   * expanded-state store for them to seed initialOpenState from on every
   * new folder.
   */
  openByDefault?: boolean;
  onMove?: (args: {
    dragIds: string[];
    dragNodes: NodeApi<T>[];
    parentId: string | null;
    parentNode: NodeApi<T> | null;
    index: number;
  }) => void | Promise<void>;
  onToggle?: (id: string) => void;
  onSelect?: (nodes: NodeApi<T>[]) => void;
  onDelete?: (args: { ids: string[]; nodes: NodeApi<T>[] }) => void | Promise<void>;
  disableDrop?: (args: {
    parentNode: NodeApi<T>;
    dragNodes: NodeApi<T>[];
    index: number;
  }) => boolean;
  disableDrag?: (node: T) => boolean;
  renderRow: (props: TreeViewRenderRowProps<T>) => ReactNode;
}

export function TreeView<T extends TreeViewNode>({
  data,
  treeRef,
  initialOpenState,
  openByDefault = false,
  onMove,
  onToggle,
  onSelect,
  onDelete,
  disableDrop,
  disableDrag,
  renderRow,
}: TreeViewProps<T>) {
  const observerRef = useRef<ResizeObserver | null>(null);
  const treeAreaRef = useRef<HTMLDivElement | null>(null);
  const [treeHeight, setTreeHeight] = useState(400);
  const setTreeAreaEl = useCallback((el: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    treeAreaRef.current = el;
    if (!el) return;
    const measure = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) setTreeHeight(Math.floor(h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    observerRef.current = ro;
  }, []);
  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={setTreeAreaEl}
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <Tree<T>
        ref={treeRef}
        data={data}
        idAccessor="id"
        childrenAccessor="children"
        initialOpenState={initialOpenState}
        openByDefault={openByDefault}
        onToggle={onToggle}
        onMove={onMove}
        onSelect={onSelect}
        onDelete={onDelete}
        disableDrop={disableDrop}
        disableDrag={disableDrag ?? (() => false)}
        rowHeight={32}
        width="100%"
        height={treeHeight}
      >
        {(props) =>
          renderRow({
            node: new Proxy(props.node, {
              get(target, prop) {
                if (prop === "data") return target.data.data;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const v = (target as any)[prop];
                return typeof v === "function" ? v.bind(target) : v;
              },
            }) as unknown as NodeApi<TreeRowData>,
            rawNode: props.node,
            style: props.style,
            dragHandle: props.dragHandle,
          })
        }
      </Tree>
    </div>
  );
}
