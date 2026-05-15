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
 * Plan 03-07 wires:
 *   - onMove: drag-drop dispatches POST /notes/{id}/move OR /folders/move,
 *     then refresh()es the tree (server is the source of truth — simpler
 *     than precise revert).
 *   - disableDrop: cycle prevention — reject dropping a folder onto its
 *     own descendant (defense-in-depth: server also has ErrCycle).
 *   - DeleteConfirmDialog state managed here; opens when a row's
 *     onRequestDelete fires; Confirm dispatches deleteNote / deleteFolder
 *     with recursive=true.
 *   - The 5 locked toast tuples (UI-SPEC §Surface 5) are surfaced from
 *     surfaceError() based on TreeMutationError.code + the operation name.
 *   - Plan 03-18 (Gap R2-3): a `treeRef` imperative handle into the
 *     react-arborist <Tree> lets us poke its react-window
 *     FixedSizeList row-position cache after a successful create — see
 *     resetTreeListLayout helper below.
 *   - Plan 03-22 (Gap R2-6) — Direction B (filename → H1): after a
 *     successful note rename, handleCommitRename additionally fetches
 *     the renamed note's content via getNote, rewrites the first H1
 *     line to match the new basename via rewriteH1, and writes the
 *     content back via updateNote. No-op when the file has no H1
 *     (research §2.4: do NOT auto-insert) or when the existing H1
 *     already matches the new basename (loop guard against
 *     Direction-A round-trips). Folder renames bypass this path —
 *     folders have no H1.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tree, type NodeApi, type TreeApi } from "react-arborist";

import { extractH1FromContent, rewriteH1 } from "../lib/h1Extract";
import { getNote, updateNote } from "../lib/notesApi";
import { useFileTree } from "../lib/useFileTree";
import { useTreeStore } from "../lib/useTreeStore";
import {
  TreeMutationError,
  useTreeMutations,
} from "../lib/useTreeMutations";
import { useTreeCreateActions } from "../lib/useTreeCreateActions";
import type {
  Tree as WireTree,
  TreeNode as WireTreeNode,
} from "../lib/treeApi";
import { listTagNotes, type NoteSummary } from "../lib/tagsApi";
import { TreeRow, type TreeRowData } from "./TreeRow";
import { TreeEmptyState } from "./TreeEmptyState";
import { TreeErrorState } from "./TreeErrorState";
import {
  DeleteConfirmDialog,
  type DeleteTarget,
} from "./DeleteConfirmDialog";
import { ActiveTagFilterChip } from "./ActiveTagFilterChip";
import { useToast } from "./Toast";

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
/**
 * Build a path → noteId lookup map by walking the wire tree.
 * Used by adaptToArborist to resolve parentNoteId for attachment files.
 * Only note nodes are indexed — folder and file nodes are skipped.
 */
function buildNotePathMap(nodes: readonly WireTreeNode[]): Map<string, string> {
  const map = new Map<string, string>();
  const visit = (n: WireTreeNode) => {
    if (n.kind === "note") {
      map.set(n.path, n.id);
    } else if (n.kind === "folder" && n.children) {
      for (const child of n.children) visit(child);
    }
  };
  for (const n of nodes) visit(n);
  return map;
}

/**
 * Derive the parentNoteId for a file node at `filePath`.
 *
 * Plan 07-26 (UAT-2 R1-7) narrowed scope: only files inside an
 * `attachments/` subfolder are click-routable in v1. The parent note is
 * the .md file whose path, with the `.md` extension removed, equals the
 * directory containing the `attachments/` folder.
 *
 * Example: "parent/attachments/photo.png"
 *   → attachments parent dir: "parent"
 *   → owner note path: "parent.md" → look up its UUID.
 *
 * Returns undefined if the file is not inside an attachments/ folder or
 * if no matching note is found in the path map.
 */
function deriveParentNoteId(
  filePath: string,
  notePathMap: Map<string, string>,
): string | undefined {
  const idx = filePath.indexOf("/attachments/");
  if (idx < 0) return undefined; // not inside attachments/
  // Everything before "/attachments/" is the directory that owns the attachments folder.
  // e.g. "gallery/attachments/photo.png" → ownerDir = "gallery"
  const ownerDir = filePath.slice(0, idx);

  // Strategy 1: look for a note at "{ownerDir}.md" (root-sibling pattern).
  // Example: notes/attachments/photo.png → ownerDir="" → ownerNotePath=".md" (invalid).
  // Example: gallery/attachments/photo.png → ownerDir="gallery" → "gallery.md" (root-level note).
  const siblingNote = ownerDir + ".md";
  if (notePathMap.has(siblingNote)) {
    return notePathMap.get(siblingNote);
  }

  // Strategy 2: look for any note INSIDE ownerDir (e.g., "gallery/note.md").
  // The GetAttachment handler places attachments at {noteParentDir}/attachments/,
  // so any note in ownerDir/ shares the same attachments folder.
  // Return the first match (alphabetically first due to Map insertion order from sortChildren).
  const prefix = ownerDir + "/";
  for (const [notePath, noteId] of notePathMap) {
    if (notePath.startsWith(prefix) && notePath.endsWith(".md")) {
      return noteId;
    }
  }

  return undefined;
}

export function adaptToArborist(
  node: WireTreeNode,
  notePathMap?: Map<string, string>,
): ArboristNode {
  if (node.kind === "folder") {
    return {
      id: "folder:" + node.path,
      name: node.name,
      data: { kind: "folder", path: node.path, name: node.name },
      children: (node.children ?? []).map((c) => adaptToArborist(c, notePathMap)),
    };
  }
  // Plan 07-26 (UAT-2 R1-7): render file nodes as interactive leaves.
  // parentNoteId is resolved from the notePathMap (built from the wire tree)
  // so that the attachment-file click handler can route to the correct
  // /api/v1/attachments/{noteId}/{filename} endpoint.
  if (node.kind === "file") {
    const parentNoteId = notePathMap
      ? deriveParentNoteId(node.path, notePathMap)
      : undefined;
    return {
      id: "file:" + node.path,
      name: node.name,
      data: { kind: "file", path: node.path, name: node.name, parentNoteId },
    };
  }
  // After handling "folder" and "file", TypeScript narrows node.kind to "note".
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
  // Build note path map once for parentNoteId resolution.
  const notePathMap = buildNotePathMap(wireTree.root);
  return wireTree.root.map((n) => adaptToArborist(n, notePathMap));
}

// ────────────────────────────────────────────────────────────────────
// Path helpers (private to this file; pure functions for testability).
// ────────────────────────────────────────────────────────────────────

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function composeNewPath(parent: string, name: string): string {
  if (parent === "") return name;
  return `${parent}/${name}`;
}

// ────────────────────────────────────────────────────────────────────
// computeMoveTarget — Gap 2 closure (Plan 03-11).
//
// Pure resolver for drag-drop destination paths. Given the source's
// wire path and the resolved destination parent NodeApi, compute the
// proposed newPath and decide whether this drop is a no-op (the user
// dragged a row onto its own parent — same path → no server-side
// change required).
//
// Why this exists as a pure function:
//   - The previous handleMove read parentId (a string) and reconstructed
//     the destination parent path by string-slicing on the "folder:"
//     prefix. That worked when parentId was the parent's prefixed id,
//     but in the live runtime react-arborist sometimes hands us a
//     parentId that doesn't begin with "folder:" — the slice falls
//     through, parentPath collapses to "", and we ask the server to
//     move "projects/jasper/scratch.md" → "scratch.md" (which then
//     409s as a same-name collision at root, OR worse, if the
//     fallthrough happened mid-tree, generates a same-path move).
//   - Reading parentNode (the resolved NodeApi) and pulling its
//     wire-path directly off `.data.data.path` avoids the slicing
//     ambiguity entirely. parentNode is null IFF the drop target is
//     root; otherwise parentNode.data.data.kind is "folder" (notes are
//     leaves).
//
// The no-op guard is byte-identical equality of the computed newPath
// to sourcePath. That catches:
//   - root → root drag of a root-level note
//   - same-folder drag at any depth
//   - same-folder drag of a folder onto its current parent
// ────────────────────────────────────────────────────────────────────
export interface MoveTarget {
  newPath: string;
  isNoOp: boolean;
}

export function computeMoveTarget(args: {
  sourcePath: string;
  parentNode: NodeApi<ArboristNode> | null;
}): MoveTarget {
  const { sourcePath, parentNode } = args;
  let parentPath = "";
  if (parentNode != null) {
    const pData = parentNode.data.data;
    if (pData.kind === "folder") {
      parentPath = pData.path;
    } else {
      // Defensive: react-arborist treats notes as leaves, so a note
      // should never appear as a parentNode. If it ever does (bug in
      // arborist or in our adapter), walk up to the note's own parent
      // (which IS a folder, or null = root) instead of constructing a
      // path that would include the note's basename.
      const grand = parentNode.parent;
      if (grand && grand.data.data.kind === "folder") {
        parentPath = grand.data.data.path;
      } else {
        parentPath = "";
      }
    }
  }
  const baseName = basename(sourcePath);
  const newPath = composeNewPath(parentPath, baseName);
  return { newPath, isNoOp: newPath === sourcePath };
}

/**
 * UX-13 (Plan 07): decide which DeleteConfirmDialog variant to open.
 *
 * Pure function so the multi-vs-single branch is unit-testable without
 * driving react-arborist's selection through jsdom (which is fragile —
 * Cmd+click in jsdom triggers react-dnd's hover invariants and selection
 * doesn't always propagate through the Redux store synchronously).
 *
 * Contract:
 *   - If 2+ selected nodes AND the requested row is one of them →
 *     return { kind: "multi", count: N } (batch delete prompt).
 *   - Otherwise the caller routes to the existing single-target branches
 *     (note vs. folder copy from countDescendants).
 *
 * Exported for direct unit testing.
 */
export function buildMultiDeleteTarget(
  d: TreeRowData,
  selectedNodes: ReadonlyArray<NodeApi<ArboristNode>>,
): { kind: "multi"; count: number } | null {
  const isMulti =
    selectedNodes.length > 1 &&
    selectedNodes.some((n) => n.data.data === d);
  if (isMulti) {
    return { kind: "multi", count: selectedNodes.length };
  }
  return null;
}

/**
 * UX-13 (Plan 07): execute a batch delete over the captured snapshot of
 * arborist's selectedNodes. Sequential per-item iteration; partial
 * completion is graceful — accumulate failures and surface a "deleted N
 * of M items" toast through the caller's surfaceError.
 *
 * Returns { succeeded, total } so the caller can decide whether to
 * surface the partial-completion toast.
 *
 * Exported for direct unit testing.
 */
export async function executeBatchDelete(
  selectedSnapshot: ReadonlyArray<NodeApi<ArboristNode>>,
  muts: {
    deleteNote: (id: string) => Promise<unknown>;
    deleteFolder: (path: string, recursive: boolean) => Promise<unknown>;
  },
): Promise<{ succeeded: number; total: number }> {
  let succeeded = 0;
  const total = selectedSnapshot.length;
  for (const node of selectedSnapshot) {
    const data = node.data.data;
    try {
      if (data.kind === "note") {
        await muts.deleteNote(data.id);
      } else {
        await muts.deleteFolder(data.path, true);
      }
      succeeded += 1;
    } catch (err) {
      // Accumulate, continue iteration. Partial completion is the
      // graceful degradation path: some entries delete, some fail
      // (e.g. server returns 409 / 500 for one).
      console.warn(
        "executeBatchDelete: per-item delete failed; continuing",
        err,
      );
    }
  }
  return { succeeded, total };
}

/**
 * UX-13 (Plan 07): the descendant-deselect cascade. When a folder enters
 * multi-selection, every descendant id is collected and passed to
 * `deselect`. Operations apply to the directory whole, not its contents.
 *
 * Pure factory so the cascade is unit-testable without driving
 * react-arborist's selection through jsdom.
 *
 * Exported for direct unit testing.
 */
export function deselectDescendantsOfFolders(
  nodes: ReadonlyArray<NodeApi<ArboristNode>>,
  deselect: (id: string) => void,
): void {
  const selectedFolders = nodes.filter(
    (n) => n.data.data.kind === "folder",
  );
  if (selectedFolders.length === 0) return;
  const collectIds = (n: NodeApi<ArboristNode>): string[] => {
    const out: string[] = [];
    if (!n.children) return out;
    for (const child of n.children) {
      out.push(child.id);
      out.push(...collectIds(child));
    }
    return out;
  };
  for (const folder of selectedFolders) {
    for (const id of collectIds(folder)) {
      deselect(id);
    }
  }
}

/**
 * Walk the wire tree starting at the matching folder path; returns the
 * counts of immediate notes + immediate subfolders for the delete
 * dialog body.
 */
export function countDescendants(
  tree: WireTree | null,
  folderPath: string,
): { notes: number; folders: number } {
  let notes = 0;
  let folders = 0;
  const findFolder = (
    nodes: readonly WireTreeNode[],
  ): WireTreeNode | null => {
    for (const n of nodes) {
      if (n.kind === "folder" && n.path === folderPath) return n;
      if (n.kind === "folder" && n.children) {
        const found = findFolder(n.children);
        if (found) return found;
      }
    }
    return null;
  };
  if (!tree) return { notes, folders };
  const folder = findFolder(tree.root);
  if (!folder || folder.kind !== "folder" || !folder.children)
    return { notes, folders };
  for (const child of folder.children) {
    if (child.kind === "folder") folders++;
    else notes++;
  }
  return { notes, folders };
}

/**
 * BL-02 (Phase 5.5 gap-closure Plan 10) — cycle-prevention check for the
 * native-DnD bypass in handleNativeDragOver / handleNativeDrop. Mirrors
 * handleDisableDrop's contract: a folder cannot be dropped onto itself or
 * any of its own descendants.
 *
 * The native-DnD path bypasses arborist's onMove pipeline (which is what
 * runs handleDisableDrop), so we replicate the rule here.
 *
 * Note-kind dragNodes are ignored — only folder-kind ancestry creates a
 * cycle. The string-prefix check uses `+ "/"` as the separator so unrelated
 * sibling folders that happen to share a name prefix ("proj" vs "projects")
 * do not register as descendants.
 *
 * Exported for direct unit testing.
 */
export function isCycleDrop(
  dragNodes: NodeApi<ArboristNode>[],
  destFolderPath: string,
): boolean {
  for (const dn of dragNodes) {
    if (dn.data.data.kind !== "folder") continue;
    const src = dn.data.data.path;
    if (destFolderPath === src) return true;
    if (destFolderPath.startsWith(src + "/")) return true;
  }
  return false;
}

/**
 * resetTreeListLayout — Gap R2-3 closure (Plan 03-18).
 *
 * react-arborist v3.5 wraps rows in react-window's FixedSizeList,
 * which caches per-row Y-offsets. When the wire-tree grows by one node
 * (optimistic create + broadcast refresh), the cache briefly returns
 * stale offsets and the new row paints at the wrong `top` (visually:
 * "halfway under the title bar"). The fix is to invalidate the cache
 * once after a successful create.
 *
 * Three-tier fallback:
 *   1. Prefer resetAfterIndex(0) if exposed — forward-compat for any
 *      future arborist version that swaps to VariableSizeList.
 *   2. Fall back to forceUpdate() — the FixedSizeList's built-in
 *      React.Component method (always present today; re-renders the
 *      list against current state).
 *   3. Final fallback: silent no-op (defensive — neither method should
 *      ever be missing on a real <Tree> ref).
 *
 * The helper is also a no-op when `treeRef.current` or its `list.current`
 * is null (covers mount-time races and unit-test environments without a
 * real react-window mount).
 *
 * Exported for direct unit testing.
 */
export function resetTreeListLayout(
  ref: React.RefObject<TreeApi<ArboristNode> | null>,
): void {
  const tree = ref.current;
  if (!tree) return;
  const list = tree.list?.current;
  if (!list) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyList = list as any;
  if (typeof anyList.resetAfterIndex === "function") {
    anyList.resetAfterIndex(0);
    return;
  }
  if (typeof anyList.forceUpdate === "function") {
    anyList.forceUpdate();
    return;
  }
  // No-op — neither primitive available. Defensive guard; unreachable
  // against react-arborist v3.5 + react-window 1.x.
}

// ────────────────────────────────────────────────────────────────────
// Module-level ref shim for cross-component callers (e.g., Breadcrumbs
// in TopBar). Set inside the FileTree component's useEffect when
// treeRef.current becomes available; cleared on unmount.
//
// Mirrors the broadcastRefresh pattern in useFileTree.ts — module-level
// state rather than a context/prop so Breadcrumbs can import this
// directly without a circular-dependency or prop-drilling problem.
// ────────────────────────────────────────────────────────────────────
let currentTreeRef: TreeApi<ArboristNode> | null = null;

/**
 * Expand and scroll the file tree to `folderPath`. Called by
 * Breadcrumbs when the user clicks a folder segment.
 *
 * Three-step contract:
 *   1. Persist the expanded state in useTreeStore (so a reload preserves
 *      the open folder; toggleExpanded is idempotent-open: only calls
 *      if not already in the expanded set).
 *   2. Open + scroll in react-arborist (if mounted).
 *   3. Ensure the notes sidebar is visible so the user sees the result.
 */
export function expandAndScrollToFolder(folderPath: string): void {
  if (!folderPath) return;
  const state = useTreeStore.getState();
  // Only call toggleExpanded when the folder is NOT already expanded —
  // toggleExpanded is a true toggle (open→close if called twice).
  if (!state.expanded.has(folderPath)) {
    state.toggleExpanded(folderPath);
  }
  const id = "folder:" + folderPath;
  try {
    currentTreeRef?.open(id);
    currentTreeRef?.scrollTo(id, "auto");
  } catch {
    // FileTree may be unmounted or arborist API mismatch — persistence
    // step above is sufficient; ignore.
  }
  // Always ensure the sidebar is visible after a breadcrumb folder click.
  state.setNotesSidebarVisible(true);
}

export interface FileTreeProps {
  onSelectNote: (id: string) => void;
}

export function FileTree({ onSelectNote }: FileTreeProps) {
  const { tree, loading, error, refresh } = useFileTree();
  const muts = useTreeMutations();
  const { createNoteAt, createFolderAt } = useTreeCreateActions();
  const { toast } = useToast();

  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(
    null,
  );

  // Gap R2-3 (Plan 03-18) — imperative handle into react-arborist's
  // <Tree> so we can poke its react-window FixedSizeList row-position
  // cache after a create. Without this, optimistic-update +
  // broadcast-refresh layouts the new row at a stale Y-offset until the
  // next interaction. See resetTreeListLayout helper above.
  const treeRef = useRef<TreeApi<ArboristNode> | null>(null);

  // Plan 06.6-07 — sync the module-level currentTreeRef so that
  // expandAndScrollToFolder (called by Breadcrumbs) can reach into the
  // arborist TreeApi from outside this component. Cleared on unmount so
  // callers gracefully no-op when the sidebar is hidden.
  useEffect(() => {
    currentTreeRef = treeRef.current;
    return () => {
      currentTreeRef = null;
    };
  }, []);

  // Bug A + B native DnD fix: track the currently dragged nodes in a ref
  // so our window-level drop handler can access them even after react-dnd
  // has cleared its internal drag state via endDrag().
  //
  // Populated by our window-level 'dragstart' listener (fires after
  // react-dnd's handleTopDragStart + arborist's dnd.dragStart dispatch).
  // Cleared on 'drop' (consumed) and 'dragend' (cleanup).
  const nativeDragInfoRef = useRef<{
    dragIds: string[];
    dragNodes: NodeApi<ArboristNode>[];
  } | null>(null);

  // Dynamic Tree height — react-arborist requires a numeric height
  // and uses react-window's FixedSizeList internally. ResizeObserver
  // tracks the live size of the bounded parent (Sidebar's tree-area
  // shell, height = `minmax(0, 1fr)` of viewport) and feeds it back
  // so the Tree fills exactly the available area; long lists then
  // scroll inside the Tree's own scroller instead of inflating the
  // parent.
  //
  // Callback ref pattern (NOT useRef + useEffect): FileTree has
  // several early-return branches above the main JSX (loading /
  // empty / error). On the very first render those return BEFORE
  // the ref-bearing wrap exists, so a useEffect-based observer
  // would install with `current === null` and never re-attach when
  // the ref later populated — leaving the Tree stuck at the default
  // height. The callback ref fires on every attach/detach, which
  // covers the loading→loaded transition uniformly.
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

  // Phase 6 — Plan 06-08: flat-list mode when activeTagFilter is active.
  // When a tag is selected in TagBrowserSection, useTreeStore's activeTagFilter
  // becomes non-null. FileTree fetches tag notes via listTagNotes and renders
  // a flat list (no arborist tree). ActiveTagFilterChip is pinned above the list.
  // activeNoteIdForFlatList is subscribed here (before early returns) to satisfy
  // the Rules of Hooks — hooks must be called unconditionally.
  const activeTagFilter = useTreeStore((s) => s.activeTagFilter);
  const activeNoteIdForFlatList = useTreeStore((s) => s.activeNoteId);
  const [flatNotes, setFlatNotes] = useState<NoteSummary[] | null>(null);
  const [flatLoading, setFlatLoading] = useState(false);

  useEffect(() => {
    if (!activeTagFilter) {
      setFlatNotes(null);
      return;
    }
    let cancelled = false;
    setFlatLoading(true);
    void listTagNotes(activeTagFilter)
      .then((notes) => {
        if (!cancelled) {
          setFlatNotes(notes);
          setFlatLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFlatNotes([]);
          setFlatLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeTagFilter]);

  const data = useMemo(() => (tree ? adaptTree(tree) : []), [tree]);

  // Gap R2-3 — when the wire shape changes (a new node was added by
  // any path: toolbar `+`, per-row context-menu, drag-drop, etc.),
  // invalidate the FixedSizeList row-position cache once. data is
  // re-derived only when `tree` (the wire shape) changes — on
  // expand/collapse, `tree` is unchanged, so this effect does NOT
  // fire. T-R2-3-01 disposition (accept): bounded by the rate of
  // human-driven create/delete/move actions.
  useEffect(() => {
    resetTreeListLayout(treeRef);
  }, [data]);

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

  // ──────────────────────────────────────────────────────────────────
  // Toast surfacing — the 5 locked tuples from UI-SPEC §Surface 5.
  // The opName drives the case-collision branch (move uses a
  // different copy than create/rename).
  // ──────────────────────────────────────────────────────────────────
  const surfaceError = useCallback(
    (
      err: unknown,
      opName: "rename" | "create" | "delete" | "move" | "refresh",
    ) => {
      if (err instanceof TreeMutationError) {
        if (err.code === "case_collision" && opName === "move") {
          toast({
            title: "That folder already has a file with that name.",
            description: `\`${err.message}\` exists. Try a different name or drop into a different folder.`,
            variant: "error",
          });
          return;
        }
        if (err.code === "case_collision") {
          toast({
            title: "That name already exists.",
            description: `${err.message} Try a different name.`,
            variant: "error",
          });
          return;
        }
        if (err.code === "invalid_request") {
          toast({
            title: "That name has characters that aren't allowed.",
            description:
              "Use letters, numbers, dashes, and underscores in note and folder names.",
            variant: "error",
          });
          return;
        }
      }
      toast({
        title: "Something went wrong on the server.",
        description:
          err instanceof Error
            ? err.message
            : "Try again or check the logs.",
        variant: "error",
      });
    },
    [toast],
  );

  // Per-row "New note" / "New folder" — delegate to the shared hook
  // (Sidebar's toolbar uses the same). After the create resolves, fire
  // the FixedSizeList layout reset (Gap R2-3) so the new row paints at
  // its correct Y-offset on the first paint. The data-effect above is
  // the primary path; these per-handler calls are belt-and-suspenders
  // for the per-row context-menu create case.
  const handleRequestNewNote = useCallback(
    async (parentPath: string) => {
      await createNoteAt(parentPath);
      resetTreeListLayout(treeRef);
    },
    [createNoteAt],
  );

  const handleRequestNewFolder = useCallback(
    async (parentPath: string) => {
      await createFolderAt(parentPath);
      resetTreeListLayout(treeRef);
    },
    [createFolderAt],
  );

  const handleRequestRename = useCallback((d: TreeRowData) => {
    if (d.kind === "file") return; // Plan 07-26: file nodes are not renameable in v1
    useTreeStore
      .getState()
      .startRename(d.kind, d.kind === "folder" ? d.path : d.id);
  }, []);

  const handleCommitRename = useCallback(
    async (d: TreeRowData, newValue: string) => {
      try {
        if (d.kind === "note") {
          // Reattach .md per Surface 3 contract — the input contains
          // only the basename for notes; the server expects the full
          // file name in the new_path.
          const parent = (() => {
            const i = d.path.lastIndexOf("/");
            return i === -1 ? "" : d.path.slice(0, i);
          })();
          const newPath = composeNewPath(parent, newValue + ".md");
          // Bug 5 fix (same-path guard): if the computed new path is identical to
          // the current path, the file is already correctly named. This happens when
          // the user accepts the placeholder name for a newly created note (isNew=true
          // path in RenameInput). Skip the API call and close cleanly — the backend
          // would otherwise reject the same-path move with ErrCaseCollision (409)
          // because MoveFile's target-exists check fires before it detects old==new.
          if (newPath === d.path) {
            useTreeStore.getState().endRename();
            return;
          }
          await muts.moveNote(d.id, newPath);

          // Plan 03-22 (Gap R2-6) — Direction B: bidirectional binding
          // per PROJECT.md 2026-05-03 Key Decision. After a successful
          // tree-rename, rewrite the first H1 in the file content to
          // match the new basename. No-op cases:
          //   - file has no H1 (research §2.4: do NOT auto-insert).
          //   - existing H1 already matches newValue (rewriteH1
          //     returns the input byte-for-byte; we detect that and
          //     skip the redundant updateNote — also serves as the
          //     loop guard against a Direction-A round-trip that just
          //     landed on the server with the H1 already in sync).
          //
          // Best-effort path — the move already committed. A getNote
          // failure (file vanished) drops to a warn-level log; an
          // updateNote failure surfaces a half-state toast so the user
          // knows the filename and the H1 may not match.
          try {
            const noteResp = await getNote(d.id);
            if (noteResp.data) {
              const currentH1 = extractH1FromContent(noteResp.data.content);
              if (currentH1 !== null && currentH1 !== newValue) {
                const newContent = rewriteH1(noteResp.data.content, newValue);
                if (newContent !== noteResp.data.content) {
                  const updResp = await updateNote(d.id, newContent);
                  if (updResp.error) {
                    toast({
                      title: "Renamed the file, but couldn't update the heading.",
                      description:
                        "The filename and the H1 in the file may not match. Open the note and re-save to align them.",
                      variant: "error",
                    });
                  } else {
                    // Plan 03-23 — broadcast refresh so the tree picks
                    // up the title freshly extracted from the rewritten
                    // H1 (Service.Update title-refresh). Without this,
                    // moveNote's refresh fired with the OLD H1 still
                    // in the file (Title="Old Title"), and the
                    // subsequent updateNote landed Title="New Name" in
                    // the index but the FileTree never re-fetched.
                    await refresh();
                  }
                }
              }
            } else if (noteResp.error) {
              console.warn(
                "FileTree.handleCommitRename: post-rename getNote failed; H1 not rewritten (reconciler / next save will heal)",
                noteResp.error,
              );
            }
          } catch (rewriteErr) {
            // Defense-in-depth — the rewrite is best-effort. Don't fail
            // the whole rename if it can't run; the move already
            // succeeded. Log at warn level so it surfaces in the
            // browser console for triage but doesn't reach the toast.
            console.warn(
              "FileTree.handleCommitRename: H1 rewrite failed; rename still committed",
              rewriteErr,
            );
          }
        } else {
          const parent = (() => {
            const i = d.path.lastIndexOf("/");
            return i === -1 ? "" : d.path.slice(0, i);
          })();
          const newPath = composeNewPath(parent, newValue);
          // Bug 5 fix (same-path guard): same as note branch above — if the computed
          // new path is identical to the current path, close the rename cleanly without
          // an API call. The backend rejects a same-path folder move with ErrCycle (400)
          // via isPathInside(same, same) → true.
          if (newPath === d.path) {
            useTreeStore.getState().endRename();
            return;
          }
          await muts.moveFolder(d.path, newPath);
        }
        // Plan 03-09 (Gap 1): the mutator already refreshed the tree
        // on success — no need to refresh again here.
        useTreeStore.getState().endRename();
      } catch (e) {
        surfaceError(e, "rename");
        // Re-throw so RenameInput catches and re-renders with the
        // server's inline error message — letting the user retry.
        throw e;
      }
    },
    [muts, surfaceError, toast, refresh],
  );

  // ──────────────────────────────────────────────────────────────────
  // UX-13 (Plan 07) — handleSelect: descendant-deselect wrapper.
  //
  // When a folder enters multi-selection, deselect every descendant of
  // that folder (operations apply to the directory whole, not its
  // contents). Mirrors RESEARCH §Pattern 4 descendant-deselect.
  //
  // Wired into the <Tree onSelect={handleSelect} ...> prop below. arborist
  // calls onSelect on every selection change, so the deselect cascade
  // re-runs each time the user toggles selection — keeps the invariant
  // even after partial deselects.
  // ──────────────────────────────────────────────────────────────────
  const handleSelect = useCallback(
    (nodes: NodeApi<ArboristNode>[]) => {
      // Delegates to the pure helper so the cascade is unit-testable.
      deselectDescendantsOfFolders(nodes, (id) =>
        treeRef.current?.deselect(id),
      );
    },
    [],
  );

  const handleRequestDelete = useCallback(
    (d: TreeRowData) => {
      // UX-13 (Plan 07) — if this row is part of a multi-selection,
      // route to the batch-delete branch so the user sees ONE prompt
      // ("Delete N items?") instead of N sequential prompts.
      //
      // Multi-selection contract: read tree.selectedNodes (length and
      // identity match) via the imperative arborist handle.
      const selected = treeRef.current?.selectedNodes ?? [];
      const multi = buildMultiDeleteTarget(d, selected);
      if (multi !== null) {
        setDeleteTarget(multi);
        return;
      }
      // Existing single-target branches.
      // WR-09 (Phase 5.5 gap-closure Plan 13): stash the canonical id (note)
      // and path (folder) on the dialog target so handleConfirmDelete can
      // dispatch deletion directly without re-deriving the identifier from
      // the display name (the previous lookup was ambiguous when two
      // siblings shared a basename across subtrees).
      if (d.kind === "note") {
        setDeleteTarget({
          kind: "note",
          name: basename(d.path),
          id: d.id,
        });
      } else {
        const counts = countDescendants(tree, d.path);
        setDeleteTarget({
          kind: "folder",
          name: d.name,
          path: d.path,
          noteCount: counts.notes,
          subfolderCount: counts.folders,
        });
      }
    },
    [tree],
  );

  // Plan 17 Bug C (UX-13) — multi-delete via Backspace/Delete keystroke.
  //
  // After a Cmd-click, focus lives on arborist's outer RowContainer
  // wrapper (NOT our inner <div role="treeitem">), so TreeRow's
  // `onKeyDown` doesn't fire. Two paths needed:
  //
  // 1) Backspace: react-arborist's default-container.js keymap handles
  //    it IF we pass `onDelete` to <Tree>. handleArboristDelete is the
  //    bridge to our existing handleRequestDelete pipeline. arborist
  //    passes us `{ nodes, ids }` of the selection; handleRequestDelete
  //    itself reads `treeRef.current.selectedNodes`, so the multi-vs-
  //    single branch is decided correctly regardless of which row we
  //    name.
  //
  // 2) Delete (Forward Delete): arborist's keymap only listens for
  //    Backspace, NOT Delete. The HUMAN-UAT walkthrough used Delete
  //    (the existing UX-13 batch-delete spec also uses Delete). Wire a
  //    tree-level keydown listener to catch Delete and route it to the
  //    same arborist API path. Scope the listener to events whose
  //    target lives inside the tree's <div role="tree">, so the editor
  //    textarea's Delete keystrokes are not hijacked.
  //
  // See 05.5-17c-INVESTIGATION.md for the full trace.
  const handleArboristDelete = useCallback(
    (args: { nodes: NodeApi<ArboristNode>[]; ids: string[] }) => {
      if (args.nodes.length === 0) return;
      const first = args.nodes[0];
      handleRequestDelete(first.data.data);
    },
    [handleRequestDelete],
  );

  useEffect(() => {
    const isInsideEditableSurface = (el: HTMLElement): boolean =>
      el.matches(
        "input, textarea, [contenteditable=true], .cm-content, .cm-content *",
      );
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (isInsideEditableSurface(target)) return;
      const insideTree = target.closest('[role="tree"]');
      if (!insideTree) return;
      const api = treeRef.current;
      if (!api) return;

      // 05.5-18: Escape clears multi-selection. When the user has
      // built up a multi-selection via Cmd+click / Shift+click, Escape
      // is the conventional "abandon this batch" affordance (matches
      // VS Code Explorer + macOS Finder). We only fire when the
      // selection has 2+ entries — single-row Escape stays a no-op so
      // it doesn't fight first-letter-jump or future single-row
      // shortcuts that arborist's keymap may want.
      if (e.key === "Escape") {
        if (api.selectedIds.size <= 1) return;
        e.preventDefault();
        // Iterate selectedIds and deselect each — react-arborist's
        // public TreeApi exposes deselect(idOrNode) but no clear-all
        // primitive in the v3.5 surface.
        for (const id of Array.from(api.selectedIds)) {
          api.deselect(id);
        }
        return;
      }

      if (e.key !== "Delete") return;
      // Mirror arborist's Backspace handler: read selectedIds, dispatch
      // to onDelete via tree.delete().
      const ids = Array.from(api.selectedIds);
      if (ids.length === 0) {
        // Nothing selected — fall back to focused node (single-target).
        const fn = api.focusedNode;
        if (!fn) return;
        e.preventDefault();
        api.delete(fn);
        return;
      }
      e.preventDefault();
      api.delete(ids);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.kind === "multi") {
        // UX-13 (Plan 07): batch delete iterates the current arborist
        // selection. Capture the snapshot of tree.selectedNodes once so
        // the loop is stable even if a per-call refresh repopulates
        // arborist's internal selection mid-iteration.
        if (!treeRef.current) return;
        const selectedSnapshot = treeRef.current.selectedNodes.slice();
        const { succeeded, total } = await executeBatchDelete(
          selectedSnapshot,
          muts,
        );
        if (succeeded < total) {
          surfaceError(
            new Error(`Deleted ${succeeded} of ${total} items.`),
            "delete",
          );
        }
      } else if (deleteTarget.kind === "note") {
        // WR-09 (Phase 5.5 gap-closure Plan 13): use target.id directly.
        // The previous name-based lookup (now removed — see comment at the
        // bottom of this file) was ambiguous when two notes shared a
        // basename across subtrees — it returned the FIRST match, which
        // could delete the wrong note after a tree refresh shuffled the
        // order. handleRequestDelete now stashes the canonical id on the
        // dialog target at click time.
        await muts.deleteNote(deleteTarget.id);
      } else {
        // WR-09: use target.path directly (same rationale — the previous
        // name-based folder lookup matched on display `name`, which is
        // ambiguous when two folders share the same display name across
        // subtrees).
        await muts.deleteFolder(deleteTarget.path, true);
      }
      // Plan 03-09 (Gap 1): the mutator already refreshed the tree
      // on success — no need to refresh again here.
      setDeleteTarget(null);
    } catch (e) {
      surfaceError(e, "delete");
    }
    // WR-09 (Plan 13): `tree` no longer appears in the dependency list —
    // handleConfirmDelete now reads canonical id/path off the dialog
    // target instead of walking the wire tree to recover them.
  }, [deleteTarget, muts, surfaceError]);

  // ──────────────────────────────────────────────────────────────────
  // Drag-drop wiring. react-arborist's onMove hands us a resolved
  // parentNode (NodeApi for the drop destination, null = root). We
  // delegate path computation + same-parent detection to the pure
  // computeMoveTarget resolver (Gap 2 closure — Plan 03-11), then
  // dispatch the matching server operation only if the drop actually
  // changes the wire path.
  // ──────────────────────────────────────────────────────────────────
  const handleMove = useCallback(
    async (args: {
      dragIds: string[];
      dragNodes: NodeApi<ArboristNode>[];
      parentId: string | null;
      parentNode: NodeApi<ArboristNode> | null;
      index: number;
    }) => {
      if (args.dragNodes.length === 0) return;

      // UX-13 (Plan 07) — multi-drag iteration. Capture all source
      // identities upfront BEFORE iteration begins (RESEARCH §Pitfall 9).
      // Note moves are id-based (refresh-stable) so capturing the id is
      // enough. Folder moves are path-based; capture the pre-iteration
      // path so a mid-loop refresh cannot swap one folder's path under
      // a sibling iteration.
      const sources = args.dragNodes.map((dn) => ({
        kind: dn.data.data.kind,
        id: dn.data.data.kind === "note" ? dn.data.data.id : null,
        path: dn.data.data.path,
      }));

      try {
        for (const src of sources) {
          const target = computeMoveTarget({
            sourcePath: src.path,
            parentNode: args.parentNode,
          });
          if (target.isNoOp) {
            // Same-parent drop — react-arborist's reordering within the
            // same parent is a UI concern only; we don't track ordering
            // server-side (notes order alphabetically per UI-SPEC §Surface
            // 1). No API call needed. Logged at debug for triage.
            console.debug("FileTree: same-parent drop ignored", {
              sourcePath: src.path,
            });
            continue;
          }
          if (src.kind === "folder") {
            await muts.moveFolder(src.path, target.newPath);
          } else if (src.id !== null) {
            await muts.moveNote(src.id, target.newPath);
          }
        }
        // Plan 03-09 (Gap 1) + Plan 08 single-flight: the mutator
        // already refreshed the tree on success per call; Plan 08's
        // useFileTree single-flight collapses the per-call refresh
        // fanout to one in-flight network round across the loop.
      } catch (e) {
        surfaceError(e, "move");
        // Server is the truth — refresh to revert the optimistic
        // arborist tree state. (KEEP this one — the mutator threw
        // before its own refresh fired, and arborist is now showing
        // an optimistic-but-rejected layout.)
        await refresh();
      }
    },
    [muts, refresh, surfaceError],
  );

  // ──────────────────────────────────────────────────────────────────
  // Bug A + B native DnD bypass — window-level listeners registered
  // AFTER react-dnd's DndProvider mounts (useEffect fires post-commit).
  //
  // Root cause: react-dnd's HTML5Backend registers handleTopDragOver on
  // window. When canDrop() returns false (broken arborist state during
  // folder-to-folder drags, or non-react-dnd targets like the trailing
  // dropzone), it sets dataTransfer.dropEffect='none'. Chrome never
  // fires the native drop event in that case, so no onMove fires.
  //
  // Fix: register our own dragover + drop listeners on window AFTER
  // react-dnd's (ordering guaranteed because useEffect runs after
  // DndProvider's synchronous mount). Our dragover overrides dropEffect
  // back to 'move' for our custom targets; our drop calls handleMove
  // directly for folder-to-folder drags (bypassing broken react-dnd).
  // ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    // dragstart: capture arborist drag state right after react-dnd's
    // handleTopDragStart fires (it calls item() in useDrag which
    // dispatches dnd.dragStart to arborist's Redux store). Our listener
    // is at window bubble phase, registered later than react-dnd's, so
    // it fires after handleTopDragStart has set dragIds.
    const handleNativeDragStart = () => {
      const api = treeRef.current;
      if (!api) {
        nativeDragInfoRef.current = null;
        return;
      }
      const nodes = api.dragNodes;
      if (!nodes.length) {
        nativeDragInfoRef.current = null;
        return;
      }
      // WR-08 (Phase 5.5 gap-closure Plan 10): derive dragIds from the
      // documented `api.dragNodes` surface. The previous private-API read
      // (removed: api .state .dnd .dragIds .slice) reached into arborist
      // internals (that shape is not part of arborist's documented public
      // API) and would silently break on a version bump.
      nativeDragInfoRef.current = {
        dragIds: nodes.map((n) => n.id),
        dragNodes: nodes,
      };
    };

    // dragover: fires AFTER react-dnd's handleTopDragOver (same window
    // bubble phase, registered later). For folder rows AND any other
    // location inside the tree (empty area below rows → root-drop
    // target), override dropEffect back to 'move' so Chrome will fire
    // the drop event. The trailing-dropzone strip was removed
    // 2026-05-10 because its 60px reserved space cropped the sidebar
    // visually; root-drop targeting is now uniform across the entire
    // tree area.
    const handleNativeDragOver = (e: DragEvent) => {
      const info = nativeDragInfoRef.current;
      if (!info) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const folderRow = target.closest('[data-tree-row-kind="folder"]');
      const insideTree = target.closest('[role="tree"]');
      if (!folderRow && !insideTree) return;
      // BL-02 (Phase 5.5 gap-closure Plan 10): cycle prevention. If the
      // hovered folder is a dragged folder (or one of its descendants),
      // do NOT preventDefault — let the browser show its native no-drop
      // cursor. Mirrors handleDisableDrop because the native-DnD path
      // bypasses arborist's onMove pipeline.
      if (folderRow) {
        const folderPath = folderRow.getAttribute("data-tree-row");
        if (folderPath !== null && isCycleDrop(info.dragNodes, folderPath)) {
          return;
        }
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    };

    // drop: fires AFTER react-dnd's handleTopDrop (same window bubble
    // phase, registered later). By then react-dnd has called endDrag()
    // which clears its own monitor state. Arborist's dnd.dragEnd()
    // fires on the following dragend event, but React root's synthetic
    // onDrop (which handles the trailing dropzone) has already fired
    // before this point. We only intercept folder-to-folder drops here.
    //
    // We use nativeDragInfoRef (captured at dragstart) because
    // api.dragNodes may be empty after endDrag().
    const handleNativeDrop = (e: DragEvent) => {
      const info = nativeDragInfoRef.current;
      nativeDragInfoRef.current = null;
      if (!info) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const folderRow = target.closest('[data-tree-row-kind="folder"]');
      const noteRow = target.closest('[data-tree-row-kind="note"]');
      const insideTree = target.closest('[role="tree"]');

      // Drop inside the tree area but NOT on any row → root-drop.
      // (2026-05-10) Replaces the dedicated trailing-dropzone strip
      // — root-drop targeting is now uniform across the empty area
      // below the rows.
      if (insideTree && !folderRow && !noteRow) {
        e.preventDefault();
        const api = treeRef.current;
        const nodes =
          (api?.dragNodes?.length ? api.dragNodes : null) ??
          info.dragNodes ??
          null;
        if (!nodes || nodes.length === 0) return;
        void handleMove({
          dragIds: nodes.map((n) => n.id),
          dragNodes: nodes,
          parentId: null,
          parentNode: null,
          index: 0,
        });
        return;
      }

      // Folder row drop (Bug B) — only handle folder-source drags.
      // Note drags use arborist's own drop path (not broken for notes).
      if (folderRow) {
        // BL-01 (Phase 5.5 gap-closure Plan 10) — filter dragNodes to
        // folders; mixed-kind selections must not silently drop, and
        // per-source dispatch happens inside handleMove. (The previous
        // `dragNodes[0].kind === "folder"` gate aborted the entire drop
        // when the first node happened to be a note.)
        const folderSources = info.dragNodes.filter(
          (n) => n.data.data.kind === "folder",
        );
        if (folderSources.length === 0) return;
        const folderPath = folderRow.getAttribute("data-tree-row");
        if (folderPath === null) return;
        // BL-02 (Phase 5.5 gap-closure Plan 10): cycle prevention — must
        // mirror handleDisableDrop because the native-DnD path bypasses
        // arborist's onMove pipeline. We re-check on the FILTERED sources
        // (note paths must not influence the cycle check).
        if (isCycleDrop(folderSources, folderPath)) return;
        e.preventDefault();
        const api = treeRef.current;
        if (!api) return;
        const parentId = "folder:" + folderPath;
        const parentNode = api.get(parentId);
        void handleMove({
          dragIds: folderSources.map((n) => n.id),
          dragNodes: folderSources,
          parentId,
          parentNode,
          index: 0,
        });
        return;
      }
    };

    const handleNativeDragEnd = () => {
      nativeDragInfoRef.current = null;
    };

    window.addEventListener("dragstart", handleNativeDragStart);
    window.addEventListener("dragover", handleNativeDragOver);
    window.addEventListener("drop", handleNativeDrop);
    window.addEventListener("dragend", handleNativeDragEnd);
    return () => {
      window.removeEventListener("dragstart", handleNativeDragStart);
      window.removeEventListener("dragover", handleNativeDragOver);
      window.removeEventListener("drop", handleNativeDrop);
      window.removeEventListener("dragend", handleNativeDragEnd);
    };
  }, [handleMove]);

  // disableDrop returns TRUE to BLOCK the drop — that's the
  // react-arborist contract. Cycle prevention: dragging a folder onto
  // itself or any of its descendants (T-03-07-04 mitigation).
  const handleDisableDrop = useCallback(
    (args: {
      parentNode: NodeApi<ArboristNode>;
      dragNodes: NodeApi<ArboristNode>[];
      index: number;
    }): boolean => {
      const { parentNode, dragNodes } = args;
      if (!parentNode || dragNodes.length === 0) return false;
      for (const dn of dragNodes) {
        if (dn.data.data.kind !== "folder") continue;
        const sourcePath = dn.data.data.path;
        // Walk up from parentNode; if we ever land on the source
        // folder itself, the drop would create a cycle — block it.
        // Guard: react-arborist's virtual root node has data: { id: ROOT_ID }
        // (not an ArboristNode), so cur.data.data is undefined on the root.
        // Stop the walk before we reach the virtual root to avoid a TypeError.
        // (Bug B / Bug C fix — the crash caused canDrop() to return false for
        // ALL folder moves, silently blocking every folder DnD.)
        let cur: NodeApi<ArboristNode> | null = parentNode;
        while (cur && cur.data?.data != null) {
          if (
            cur.data.data.kind === "folder" &&
            cur.data.data.path === sourcePath
          ) {
            return true;
          }
          cur = cur.parent;
        }
      }
      return false;
    },
    [],
  );

  // siblingNamesFor — for the inline-rename collision check. The
  // current row is excluded so renaming "foo" to "foo" doesn't trip
  // the same-name-as-myself collision.
  //
  // Bug F fix: only compare against same-kind siblings. A note named
  // "untitled.md" (display label "untitled") must NOT block renaming a
  // folder to "untitled" — they are distinct filesystem entries
  // (untitled.md vs untitled/). Filtering to nodeKind before mapping
  // ensures the RenameInput validation is kind-scoped, matching the
  // server's collision check which is also kind-scoped (mkdir checks
  // for a directory, not for any inode named the same as the basename
  // without extension).
  const siblingNamesFor = (node: NodeApi<ArboristNode>): string[] => {
    const parent = node.parent;
    const siblings = parent?.children ?? [];
    const nodeKind = node.data.data.kind;
    return siblings
      .filter((s: NodeApi<ArboristNode>) => s.id !== node.id)
      .filter((s: NodeApi<ArboristNode>) => s.data.data.kind === nodeKind)
      .map((s: NodeApi<ArboristNode>) => {
        const sd = s.data.data;
        if (sd.kind === "folder") return sd.name;
        if (sd.kind === "file") return sd.name; // Plan 07-26: file nodes use name
        // For notes, compare against the basename WITHOUT .md so it
        // matches what the user is typing in the rename input.
        return sd.title.endsWith(".md")
          ? sd.title.slice(0, -3)
          : sd.title;
      });
  };

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

  // Phase 6 — Plan 06-08: flat-list branch. When activeTagFilter is set,
  // render ActiveTagFilterChip + a flat list of notes tagged with that tag.
  // This branch supersedes the arborist tree render entirely while the filter
  // is active. The chip's × button clears the filter and returns to the normal tree.
  if (activeTagFilter !== null) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          overflow: "hidden",
        }}
      >
        <ActiveTagFilterChip />
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            overflowX: "hidden",
          }}
        >
          {flatLoading && (
            <div
              aria-hidden="true"
              style={{
                height: 1,
                background: "var(--color-accent)",
                animation: "jasper-progress-stripe 1.5s linear infinite",
              }}
            />
          )}
          {!flatLoading && flatNotes !== null && flatNotes.length === 0 && (
            <div
              style={{
                padding: "16px",
                fontSize: 12,
                color: "var(--color-text-muted)",
              }}
            >
              No notes tagged &ldquo;{activeTagFilter}&rdquo;.
            </div>
          )}
          {flatNotes !== null &&
            flatNotes.map((note) => {
              const isActive = activeNoteIdForFlatList === note.id;
              return (
                <div
                  key={note.id}
                  data-active-note={isActive ? "true" : undefined}
                  onClick={() => {
                    useTreeStore.getState().setActiveNote(note.id);
                    onSelectNote(note.id);
                  }}
                  style={{
                    height: 32,
                    padding: "0 16px",
                    display: "flex",
                    alignItems: "center",
                    cursor: "pointer",
                    fontSize: 13,
                    color: isActive
                      ? "var(--color-accent)"
                      : "var(--color-text)",
                    background: isActive
                      ? "color-mix(in srgb, var(--color-accent) 8%, transparent)"
                      : "transparent",
                    userSelect: "none",
                  }}
                >
                  {note.title}
                </div>
              );
            })}
        </div>
      </div>
    );
  }

  if (tree && tree.root.length === 0) return <TreeEmptyState />;

  if (!tree) return null;

  return (
    <>
      {/*
        Tree-area wrap — fills the Sidebar's flex column. The Tree
        sits inside it at (measured height - dropzone height); long
        lists scroll INSIDE the Tree's own scroller. flexShrink:1 +
        minHeight:0 is the standard "this column may shrink to fit"
        recipe.
      */}
      <div
        ref={setTreeAreaEl}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
      <Tree<ArboristNode>
        ref={treeRef}
        data={data}
        idAccessor="id"
        childrenAccessor="children"
        initialOpenState={initialOpenState}
        onToggle={handleToggle}
        onMove={handleMove}
        // UX-13 (Plan 07): every selection change runs the
        // descendant-deselect cascade — when a folder enters the
        // selection, its descendants exit. Operations apply to the
        // directory whole, not its contents.
        onSelect={handleSelect}
        // Plan 17 Bug C (UX-13): wire onDelete so arborist's tree-level
        // Backspace/Delete keymap routes into our handleRequestDelete
        // pipeline. Without this prop, default-container.js short-
        // circuits on Backspace, and multi-delete via keyboard is dead.
        // See 05.5-17c-INVESTIGATION.md.
        onDelete={handleArboristDelete}
        disableDrop={handleDisableDrop}
        // Plan 07-26 (UAT-2 R1-7): file nodes are read-only — prevent drag initiation.
        // BoolFunc<ArboristNode> receives the plain data object (not NodeApi); data.data is TreeRowData.
        disableDrag={(d: ArboristNode) => d.data.kind === "file"}
        rowHeight={32}
        width="100%"
        // Tree fills the entire treeAreaRef height. Root-drop is now
        // handled by the window-level handleNativeDrop checking for
        // drops inside [role="tree"] but NOT on a folder/note row —
        // there's no separate dropzone strip eating sidebar space
        // (the previous 60px reserved area read as cropped-short).
        height={treeHeight}
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
            // Gap R2-1: arborist hands us a callback ref via children
            // render-prop; attaching it on the row container is what
            // registers the row as a react-dnd drag source. Without
            // this forward, ALL drag events are silently dropped —
            // both Playwright synthetic AND real mouse drags.
            dragHandle={props.dragHandle}
            onSelectNote={onSelectNote}
            onRequestRename={handleRequestRename}
            onRequestDelete={handleRequestDelete}
            onRequestNewNote={handleRequestNewNote}
            onRequestNewFolder={handleRequestNewFolder}
            siblingNames={siblingNamesFor(props.node)}
            commitRename={handleCommitRename}
          />
        )}
      </Tree>
      </div>
      <DeleteConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        target={deleteTarget ?? { kind: "note", name: "", id: "" }}
        onConfirm={handleConfirmDelete}
      />
    </>
  );
}

// WR-09 (Phase 5.5 gap-closure Plan 13) — REMOVED.
// Two private helpers (one for notes, one for folders) previously walked
// the wire tree to recover canonical identifiers from the dialog's display
// name. That post-hoc lookup was ambiguous when two notes shared a
// basename across subtrees (returned the FIRST match, potentially the
// wrong one). `DeleteTarget` now carries `id` (note) / `path` (folder)
// directly, so the helpers are no longer needed. See `handleConfirmDelete`
// above.
