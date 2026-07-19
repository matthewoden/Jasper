/**
 * FileTree — react-arborist <Tree> wrapper + state routing.
 *
 * Branches:
 *   - useFileTree.error       → <TreeErrorState onRetry={refresh} />
 *   - loading + tree==null    → 1px indeterminate progress stripe
 *   - tree.root.length === 0  → <TreeEmptyState />
 *   - tree.root has children  → <Tree> with adapted data + TreeRow renderer
 *
 * Wire-shape adapter: react-arborist requires stable id+name+children. Folder
 * ids are "folder:" + path, note ids are "note:" + uuid. The original wire shape
 * is preserved under .data so TreeRow can branch on data.kind without re-parsing.
 *
 * Key behaviors: drag-drop dispatches the appropriate move endpoint then
 * refresh()es (server is source of truth); disableDrop prevents cycle drops;
 * DeleteConfirmDialog is managed here; after a successful note rename,
 * handleCommitRename rewrites the H1 to match the new basename (no-op when
 * the file has no H1 or when H1 already matches — loop guard against
 * the editor's direction-A round-trips).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tree, type NodeApi, type TreeApi } from "react-arborist";

import { extractH1FromContent, rewriteH1 } from "../lib/h1Extract";
import { getNote, updateNote } from "../lib/notesApi";
import { uploadFile, deleteFile, moveFile } from "../lib/filesApi";

import { createNoteFromMarkdownDrop } from "../lib/notesApi";
import { broadcastRefresh, useFileTree } from "../lib/useFileTree";
import { useTreeStore } from "../lib/useTreeStore";
import {
  TreeMutationError,
  useTreeMutations,
} from "../lib/useTreeMutations";
import { useTreeCreateActions } from "../lib/useTreeCreateActions";
import type { TreeNode as WireTreeNode } from "../lib/treeApi";
import { listTagNotes, type NoteSummary } from "../lib/tagsApi";
import { TreeRow, type TreeRowData } from "./TreeRow";
import { TreeEmptyState } from "./TreeEmptyState";
import { TreeErrorState } from "./TreeErrorState";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import type { DeleteTarget } from "./deleteConfirmDialog.utils";
import { ActiveTagFilterChip } from "./ActiveTagFilterChip";
import { useToast } from "./toast.utils";
import {
  adaptTree,
  basename,
  buildMultiDeleteTarget,
  composeNewPath,
  computeMoveTarget,
  countDescendants,
  deselectDescendantsOfFolders,
  executeBatchDelete,
  isCycleDrop,
  resetTreeListLayout,
  setCurrentTreeRef,
  type ArboristNode,
} from "./fileTree.utils";


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

  const treeRef = useRef<TreeApi<ArboristNode> | null>(null);

  useEffect(() => {
    setCurrentTreeRef(treeRef.current);
    return () => {
      setCurrentTreeRef(null);
    };
  }, []);

  const nativeDragInfoRef = useRef<{
    dragIds: string[];
    dragNodes: NodeApi<ArboristNode>[];
  } | null>(null);

  // A single drop dispatches handleMove twice — once from the native window
  // `drop` listener (folder/empty-space drops) and once from react-arborist's
  // own onMove. The first move succeeds; the duplicate then 404s because the
  // source no longer exists at its old path. Dedupe identical moves fired within
  // a short window so only the first runs.
  const lastMoveRef = useRef<{ key: string; t: number } | null>(null);

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

  const activeTagFilter = useTreeStore((s) => s.activeTagFilter);
  const activeNoteIdForFlatList = useTreeStore((s) => s.activeNoteId);

  // Collapse-all: the toolbar button clears the store's expanded set and bumps
  // this nonce; react-arborist owns its own open state, so we must close it
  // imperatively via the TreeApi (initialOpenState is read once at mount).
  const collapseAllNonce = useTreeStore((s) => s.collapseAllNonce);
  useEffect(() => {
    if (collapseAllNonce > 0) treeRef.current?.closeAll();
  }, [collapseAllNonce]);
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

  useEffect(() => {
    resetTreeListLayout(treeRef);
  }, [data]);

  const initialOpenState = useMemo<Record<string, boolean>>(() => {
    const expanded = useTreeStore.getState().expanded;
    const out: Record<string, boolean> = {};
    for (const path of expanded) out["folder:" + path] = true;
    return out;
  }, []);

  const handleToggle = useCallback((id: string) => {
    if (id.startsWith("folder:")) {
      const path = id.slice("folder:".length);
      useTreeStore.getState().toggleExpanded(path);
    }
  }, []);

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
    if (d.kind === "file") {
      useTreeStore.getState().startRename("file", d.path);
      return;
    }
    useTreeStore
      .getState()
      .startRename(d.kind, d.kind === "folder" ? d.path : d.id);
  }, []);

  const handleCommitRename = useCallback(
    async (d: TreeRowData, newValue: string) => {
      try {
        if (d.kind === "file") {
          const parent = (() => {
            const i = d.path.lastIndexOf("/");
            return i === -1 ? "" : d.path.slice(0, i);
          })();
          const newPath = composeNewPath(parent, newValue);
          if (newPath === d.path) {
            useTreeStore.getState().endRename();
            return;
          }
          await moveFile(d.path, newPath);
          useTreeStore.getState().endRename();
          await refresh();
          broadcastRefresh();
          return;
        }
        if (d.kind === "note") {
          const parent = (() => {
            const i = d.path.lastIndexOf("/");
            return i === -1 ? "" : d.path.slice(0, i);
          })();
          const newPath = composeNewPath(parent, newValue + ".md");
          if (newPath === d.path) {
            useTreeStore.getState().endRename();
            return;
          }
          await muts.moveNote(d.id, newPath);
          // A tree rename rewrites the file's first H1 (server-side and/or via
          // the rewrite below). Any optimistic liveLabel the editor set for this
          // note id is now stale and would mask the refetched title — drop it so
          // the server's title (e.g. "New Name") renders.
          useTreeStore.getState().clearLiveLabel(d.id);

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
          if (newPath === d.path) {
            useTreeStore.getState().endRename();
            return;
          }
          await muts.moveFolder(d.path, newPath);
        }
        useTreeStore.getState().endRename();
      } catch (e) {
        surfaceError(e, "rename");
        throw e;
      }
    },
    [muts, surfaceError, toast, refresh],
  );

  const handleSelectReentrant = useRef(false);
  const handleSelect = useCallback(
    (nodes: NodeApi<ArboristNode>[]) => {
      if (handleSelectReentrant.current) return;
      handleSelectReentrant.current = true;
      try {
        deselectDescendantsOfFolders(nodes, (id) =>
          treeRef.current?.deselect(id),
        );
      } finally {
        handleSelectReentrant.current = false;
      }
    },
    [],
  );

  const handleRequestDelete = useCallback(
    (d: TreeRowData) => {
      const selected = treeRef.current?.selectedNodes ?? [];
      const multi = buildMultiDeleteTarget(d, selected);
      if (multi !== null) {
        setDeleteTarget(multi);
        return;
      }
      if (d.kind === "note") {
        setDeleteTarget({
          kind: "note",
          name: basename(d.path),
          id: d.id,
        });
      } else if (d.kind === "file") {
        setDeleteTarget({
          kind: "file",
          name: d.name,
          path: d.path,
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

      if (e.key === "Escape") {
        if (api.selectedIds.size <= 1) return;
        e.preventDefault();
        for (const id of Array.from(api.selectedIds)) {
          api.deselect(id);
        }
        return;
      }

      if (e.key !== "Delete") return;
      const ids = Array.from(api.selectedIds);
      if (ids.length === 0) {
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
        await muts.deleteNote(deleteTarget.id);
      } else if (deleteTarget.kind === "file") {
        await deleteFile(deleteTarget.path);
        await refresh();
        broadcastRefresh();
      } else {
        await muts.deleteFolder(deleteTarget.path, true);
      }
      setDeleteTarget(null);
    } catch (e) {
      surfaceError(e, "delete");
    }
    // reads canonical id/path off the dialog target, not the wire tree
  }, [deleteTarget, muts, surfaceError, refresh]);

  const handleMove = useCallback(
    async (args: {
      dragIds: string[];
      dragNodes: NodeApi<ArboristNode>[];
      parentId: string | null;
      parentNode: NodeApi<ArboristNode> | null;
      index: number;
    }) => {
      if (args.dragNodes.length === 0) return;

      const sources = args.dragNodes.map((dn) => ({
        kind: dn.data.data.kind,
        id: dn.data.data.kind === "note" ? dn.data.data.id : null,
        path: dn.data.data.path,
      }));

      // Dedupe the native-listener + arborist-onMove double dispatch: same
      // sources + same target folder within 1s is always the spurious repeat
      // (a real second move would see the already-relocated source path).
      const targetKey =
        args.parentNode?.data.data.kind === "folder"
          ? args.parentNode.data.data.path
          : "root";
      const moveKey =
        sources.map((s) => s.path).sort().join("\n") + "→" + targetKey;
      const now = Date.now();
      if (
        lastMoveRef.current &&
        lastMoveRef.current.key === moveKey &&
        now - lastMoveRef.current.t < 1000
      ) {
        return;
      }
      lastMoveRef.current = { key: moveKey, t: now };

      try {
        for (const src of sources) {
          const target = computeMoveTarget({
            sourcePath: src.path,
            parentNode: args.parentNode,
          });
          if (target.isNoOp) {
            console.debug("FileTree: same-parent drop ignored", {
              sourcePath: src.path,
            });
            continue;
          }
          if (src.kind === "folder") {
            await muts.moveFolder(src.path, target.newPath);
          } else if (src.kind === "note" && src.id !== null) {
            await muts.moveNote(src.id, target.newPath);
          } else if (src.kind === "file") {
            await muts.moveFile(src.path, target.newPath);
          }
        }
        // mutator already refreshed the tree on success per call;
        // useFileTree single-flight collapses the per-call refresh fanout.
      } catch (e) {
        surfaceError(e, "move");
        await refresh();
      }
    },
    [muts, refresh, surfaceError],
  );

  useEffect(() => {
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
      nativeDragInfoRef.current = {
        dragIds: nodes.map((n) => n.id),
        dragNodes: nodes,
      };
    };

    const handleNativeDragOver = (e: DragEvent) => {
      const info = nativeDragInfoRef.current;
      if (!info) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const folderRow = target.closest('[data-tree-row-kind="folder"]');
      const insideTree = target.closest('[role="tree"]');
      if (!folderRow && !insideTree) return;
      if (folderRow) {
        const folderPath = folderRow.getAttribute("data-tree-row");
        if (folderPath !== null && isCycleDrop(info.dragNodes, folderPath)) {
          return;
        }
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    };

    const handleNativeDrop = (e: DragEvent) => {
      const info = nativeDragInfoRef.current;
      nativeDragInfoRef.current = null;
      if (!info) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const folderRow = target.closest('[data-tree-row-kind="folder"]');
      const noteRow = target.closest('[data-tree-row-kind="note"]');
      const insideTree = target.closest('[role="tree"]');

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

      if (folderRow) {
        const folderSources = info.dragNodes.filter(
          (n) => n.data.data.kind === "folder",
        );
        if (folderSources.length === 0) return;
        const folderPath = folderRow.getAttribute("data-tree-row");
        if (folderPath === null) return;
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

  const handleSidebarDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const types = e.dataTransfer?.types;
      if (!types) return;
      const hasFiles = Array.from(types).includes("Files");
      const isExternal = hasFiles && nativeDragInfoRef.current === null;
      if (isExternal) {
        e.stopPropagation();
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = "copy";
        }
      }
    },
    [],
  );

  const noteIdToPath = useMemo<Map<string, string>>(() => {
    const map = new Map<string, string>();
    if (!tree) return map;
    const visit = (n: WireTreeNode) => {
      if (n.kind === "note") {
        map.set(n.id, n.path);
      } else if (n.kind === "folder" && n.children) {
        for (const c of n.children) visit(c);
      }
    };
    for (const n of tree.root) visit(n);
    return map;
  }, [tree]);

  const parentDirOfPath = useCallback((p: string): string => {
    const idx = p.lastIndexOf("/");
    return idx < 0 ? "" : p.slice(0, idx);
  }, []);

  const handleSidebarFileDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      const types = e.dataTransfer?.types;
      if (!types) return;
      const hasFiles = Array.from(types).includes("Files");
      const isExternal = hasFiles && nativeDragInfoRef.current === null;
      if (!isExternal) return;
      e.stopPropagation();
      e.preventDefault();

      const target = e.target as HTMLElement | null;
      const rowEl = target?.closest("[data-tree-row]") as HTMLElement | null;
      let targetDir = "";
      if (rowEl) {
        const rowKind = rowEl.getAttribute("data-tree-row-kind");
        const rowAttr = rowEl.getAttribute("data-tree-row") ?? "";
        if (rowKind === "folder") {
          targetDir = rowAttr;
        } else if (rowKind === "note") {
          const notePath = noteIdToPath.get(rowAttr);
          targetDir = notePath ? parentDirOfPath(notePath) : "";
        } else if (rowKind === "file") {
          targetDir = parentDirOfPath(rowAttr);
        }
      }

      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      let anySucceeded = false;
      for (const f of files) {
        const isMarkdown = f.name.toLowerCase().endsWith(".md");
        try {
          if (isMarkdown) {
            const text =
              typeof f.text === "function"
                ? await f.text()
                : await new Promise<string>((resolve, reject) => {
                    const fr = new FileReader();
                    fr.onload = () => resolve(String(fr.result ?? ""));
                    fr.onerror = () => reject(fr.error);
                    fr.readAsText(f);
                  });
            const notePath = targetDir ? `${targetDir}/${f.name}` : f.name;
            await createNoteFromMarkdownDrop(notePath, text);
            anySucceeded = true;
          } else {
            await uploadFile(targetDir, f);
            anySucceeded = true;
          }
        } catch (err) {
          const status = (err as { status?: number } | null)?.status;
          const body = (err as { body?: string } | null)?.body ?? "";

          if (isMarkdown) {
            let title = "Note creation failed";
            let description = `Could not create note from ${f.name}.`;
            if (status === 409) {
              title = "Note already exists";
              description = `A note with that name already exists at ${targetDir === "" ? "the vault root" : targetDir}. Rename the file before dropping again.`;
            } else if (status === 400) {
              title = "Note creation rejected";
              description = `${f.name}: invalid filename or path.`;
            } else {
              const detail = (err as Error | null)?.message ?? "unknown error";
              description = `Could not create note from ${f.name}.\nReason: ${detail}\n(targetDir=${targetDir === "" ? "<root>" : targetDir}, status=${status ?? "?"})`;
            }
            toast({ title, description, variant: "error" });
            console.error("[FileTree] handleSidebarFileDrop (.md route):", {
              err,
              targetDir,
              fileName: f.name,
            });
            continue;
          }

          let title = "Upload failed";
          let description = `Could not upload ${f.name}.`;
          if (status === 413) {
            title = "File too large";
            description = "Maximum upload size is 100 MB.";
          } else if (status === 400) {
            title = "Upload rejected";
            description = `${f.name}: invalid path or filename (markdown files must be created via the new-note action, not dropped).`;
          } else if (status === 403) {
            title = "Upload rejected";
            description = "Target directory is a symlink — refused for safety.";
          } else {
            const detail = body
              ? body.slice(0, 200)
              : (err as Error | null)?.message ?? "unknown error";
            description = `Could not upload ${f.name}.\nReason: ${detail}\n(targetDir=${targetDir === "" ? "<root>" : targetDir}, status=${status ?? "?"})`;
          }
          toast({ title, description, variant: "error" });
          console.error("[FileTree] handleSidebarFileDrop:", { err, targetDir, fileName: f.name });
        }
      }

      if (anySucceeded) {
        await broadcastRefresh();
      }
    },
    [noteIdToPath, parentDirOfPath, toast],
  );

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
        if (sd.kind === "file") return sd.name;
        return sd.title.endsWith(".md")
          ? sd.title.slice(0, -3)
          : sd.title;
      });
  };

  if (error) return <TreeErrorState onRetry={refresh} />;

  if (loading && !tree) {
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
      {/* Tree-area wrap — fills the sidebar column. flexShrink:1 + minHeight:0 lets it shrink. */}
      <div
        ref={setTreeAreaEl}
        onDragOverCapture={handleSidebarDragOver}
        onDragEnterCapture={handleSidebarDragOver}
        onDropCapture={handleSidebarFileDrop}
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
        openByDefault={false}
        onToggle={handleToggle}
        onMove={handleMove}
        onSelect={handleSelect}
        onDelete={handleArboristDelete}
        disableDrop={handleDisableDrop}
        disableDrag={() => false}
        rowHeight={32}
        width="100%"
        height={treeHeight}
      >
        {(props) => (
          <TreeRow
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


