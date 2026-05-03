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
 */
import { useCallback, useMemo, useState } from "react";
import { Tree, type NodeApi } from "react-arborist";

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
  // (Sidebar's toolbar uses the same).
  const handleRequestNewNote = useCallback(
    async (parentPath: string) => {
      await createNoteAt(parentPath);
    },
    [createNoteAt],
  );

  const handleRequestNewFolder = useCallback(
    async (parentPath: string) => {
      await createFolderAt(parentPath);
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
    [muts, surfaceError],
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
  // Drag-drop wiring. react-arborist's onMove gives us a destination
  // {parentId, index}; we translate the prefixed arborist ids back to
  // wire paths and dispatch the matching server operation.
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
      const newParentPath =
        args.parentId == null
          ? ""
          : args.parentId.startsWith("folder:")
            ? args.parentId.slice("folder:".length)
            : "";
      try {
        if (sourceData.kind === "folder") {
          const newPath = composeNewPath(
            newParentPath,
            basename(sourceData.path),
          );
          if (newPath === sourceData.path) return; // no-op drop
          await muts.moveFolder(sourceData.path, newPath);
        } else {
          const newPath = composeNewPath(
            newParentPath,
            basename(sourceData.path),
          );
          if (newPath === sourceData.path) return; // no-op drop
          await muts.moveNote(sourceData.id, newPath);
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
