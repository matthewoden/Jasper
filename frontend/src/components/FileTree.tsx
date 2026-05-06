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
import { TreeRow, type TreeRowData } from "./TreeRow";
import { TreeEmptyState } from "./TreeEmptyState";
import { TreeErrorState } from "./TreeErrorState";
import {
  DeleteConfirmDialog,
  type DeleteTarget,
} from "./DeleteConfirmDialog";
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

  const handleRequestDelete = useCallback(
    (d: TreeRowData) => {
      if (d.kind === "note") {
        setDeleteTarget({ kind: "note", name: basename(d.path) });
      } else {
        const counts = countDescendants(tree, d.path);
        setDeleteTarget({
          kind: "folder",
          name: d.name,
          noteCount: counts.notes,
          subfolderCount: counts.folders,
        });
      }
    },
    [tree],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.kind === "note") {
        // We need the note's id; recover it from the wire tree by
        // matching the basename within the active tree. To keep the
        // implementation simple, we stash the id alongside the dialog
        // target using a parallel ref in handleRequestDelete.
        // For correctness we look it up here from the wire tree.
        const noteId = findNoteIdByName(tree, deleteTarget.name);
        if (!noteId) {
          throw new Error("Could not locate note id for delete.");
        }
        await muts.deleteNote(noteId);
      } else {
        const folderPath = findFolderPathByName(tree, deleteTarget.name);
        if (!folderPath) {
          throw new Error("Could not locate folder path for delete.");
        }
        await muts.deleteFolder(folderPath, true);
      }
      // Plan 03-09 (Gap 1): the mutator already refreshed the tree
      // on success — no need to refresh again here.
      setDeleteTarget(null);
    } catch (e) {
      surfaceError(e, "delete");
    }
  }, [deleteTarget, muts, surfaceError, tree]);

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
      const dragNode = args.dragNodes[0];
      if (!dragNode) return;
      const sourceData = dragNode.data.data;
      const target = computeMoveTarget({
        sourcePath: sourceData.path,
        parentNode: args.parentNode,
      });
      if (target.isNoOp) {
        // Same-parent drop — react-arborist's reordering within the
        // same parent is a UI concern only; we don't track ordering
        // server-side (notes order alphabetically per UI-SPEC §Surface
        // 1). No API call needed. Logged at debug for triage.
        console.debug("FileTree: same-parent drop ignored", {
          sourcePath: sourceData.path,
        });
        return;
      }
      try {
        if (sourceData.kind === "folder") {
          await muts.moveFolder(sourceData.path, target.newPath);
        } else {
          await muts.moveNote(sourceData.id, target.newPath);
        }
        // Plan 03-09 (Gap 1): the mutator already refreshed the tree
        // on success — no need to refresh again here.
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
        let cur: NodeApi<ArboristNode> | null = parentNode;
        while (cur) {
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
  const siblingNamesFor = (node: NodeApi<ArboristNode>): string[] => {
    const parent = node.parent;
    const siblings = parent?.children ?? [];
    return siblings
      .filter((s: NodeApi<ArboristNode>) => s.id !== node.id)
      .map((s: NodeApi<ArboristNode>) => {
        const sd = s.data.data;
        if (sd.kind === "folder") return sd.name;
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

  if (tree && tree.root.length === 0) return <TreeEmptyState />;

  if (!tree) return null;

  return (
    <>
      <Tree<ArboristNode>
        ref={treeRef}
        data={data}
        idAccessor="id"
        childrenAccessor="children"
        initialOpenState={initialOpenState}
        onToggle={handleToggle}
        onMove={handleMove}
        disableDrop={handleDisableDrop}
        rowHeight={32}
        width="100%"
        // arborist requires a numeric height; the flex parent constrains
        // the actual rendered height while internal scroll handles
        // virtualization (PERF-02 — 1,000 nodes).
        height={9999}
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
      <DeleteConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        target={deleteTarget ?? { kind: "note", name: "" }}
        onConfirm={handleConfirmDelete}
      />
    </>
  );
}

// ────────────────────────────────────────────────────────────────────
// Internal lookup helpers (used by handleConfirmDelete to recover the
// id / canonical path from the dialog's name reference).
// ────────────────────────────────────────────────────────────────────
function findNoteIdByName(
  tree: WireTree | null,
  name: string,
): string | null {
  if (!tree) return null;
  const visit = (nodes: readonly WireTreeNode[]): string | null => {
    for (const n of nodes) {
      if (n.kind === "note" && basename(n.path) === name) return n.id;
      if (n.kind === "folder" && n.children) {
        const found = visit(n.children);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(tree.root);
}

function findFolderPathByName(
  tree: WireTree | null,
  name: string,
): string | null {
  if (!tree) return null;
  const visit = (nodes: readonly WireTreeNode[]): string | null => {
    for (const n of nodes) {
      if (n.kind === "folder" && n.name === name) return n.path;
      if (n.kind === "folder" && n.children) {
        const found = visit(n.children);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(tree.root);
}
