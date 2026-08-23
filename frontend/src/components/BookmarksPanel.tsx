/**
 * BookmarksPanel lists bookmarked notes and virtual folders through the SAME
 * tree engine Notes uses — TreeView + TreeRow, not a bespoke row list.
 *
 * Row activation goes through usePaneStore.openInActivePane (BOOK-02), never
 * useTreeStore's setActiveNoteId.
 *
 * Folder collapse rides react-arborist's own open state; there is deliberately
 * no local collapsedFolders Set.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { NodeApi, TreeApi } from "react-arborist";

import { useBookmarks } from "../lib/useBookmarks";
import { useFileTree } from "../lib/useFileTree";
import { usePaneStore } from "../lib/usePaneStore";
import { useReveal } from "../lib/useReveal";
import { useTreeMutations } from "../lib/useTreeMutations";
import { useTreeStore } from "../lib/useTreeStore";
import { useWorkspace } from "../lib/useWorkspace";
import { requestFind } from "../lib/findRequest";
import { revealInNavigation } from "../lib/revealInNavigation";
import type { TreeNode as WireTreeNode } from "../lib/treeApi";
import { TreeView } from "./TreeView";
import { TreeRow, type TreeRowData } from "./TreeRow";
import { BookmarksEmptyState } from "./BookmarksEmptyState";
import { BookmarksErrorState } from "./BookmarksErrorState";
import { NewBookmarkFolderInput } from "./NewBookmarkFolderInput";
import { BookmarksSortMenu } from "./BookmarksSortMenu";
import { BookmarkFolderRenameInput } from "./BookmarkFolderRenameInput";
import {
  BookmarkOptionsMenu,
  BookmarkRowContextMenu,
  type BookmarkMenuActions,
} from "./BookmarkOptionsMenu";
import {
  BookmarkFolderContextMenu,
  BookmarkFolderOptionsMenu,
  type BookmarkFolderMenuActions,
} from "./BookmarkFolderOptionsMenu";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { MoveToFolderModal } from "./MoveToFolderModal";
import { useToast } from "./toast.utils";
import { Tooltip } from "./Tooltip";
import {
  adaptBookmarks,
  buildNoteMetaMap,
  computeBookmarkMoveDispatch,
  findNoteTitle,
} from "./bookmarkTree.utils";
import { basename, type ArboristNode } from "./fileTree.utils";
import { FolderPlus } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

/** Live note path by UUID — a bookmark only ever stores note_id. */
function findNotePath(
  nodes: ReadonlyArray<WireTreeNode>,
  id: string,
): string | null {
  for (const node of nodes) {
    if (node.kind === "note" && node.id === id) return node.path;
    if (node.kind === "folder" && Array.isArray(node.children)) {
      const found = findNotePath(node.children, id);
      if (found !== null) return found;
    }
  }
  return null;
}

export interface BookmarksPanelProps {
  onSelectNote?: (id: string) => void;
}

const toolbarRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 8,
  height: 40,
  padding: "0 8px",
  borderBottom: "1px solid var(--color-border)",
  flexShrink: 0,
};

const toolbarButtonBase: CSSProperties = {
  width: 24,
  height: 24,
  padding: 4,
  background: "transparent",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
};

/** "New bookmark folder" toolbar trigger — SidebarToolbar-sized (24x24, muted
 *  FolderPlus) with the same fg-8%-tint hover convention as SidebarTabRow's
 *  collapse button / ActivityRibbon's RibbonButton. */
function NewBookmarkFolderButton({ onClick }: { onClick: () => void }) {
  const [hovering, setHovering] = useState(false);
  return (
    <Tooltip label="New bookmark folder" side="bottom">
      <button
        type="button"
        aria-label="New bookmark folder"
        onClick={onClick}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        style={{
          ...toolbarButtonBase,
          background: hovering
            ? "color-mix(in srgb, var(--color-fg) 8%, transparent)"
            : "transparent",
        }}
      >
        <FolderPlus size={16} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

const panelColumnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
};

export function BookmarksPanel({ onSelectNote }: BookmarksPanelProps) {
  // Kept for prop-shape parity with the other sidebar panels (FileTree,
  // SidebarSearchPanel) — rows activate via usePaneStore.openInActivePane
  // directly (BOOK-02), so this callback is currently unused.
  void onSelectNote;

  const {
    bookmarks,
    bookmarkFolders,
    error,
    refresh,
    toggleBookmark,
    moveToFolder,
    createFolder,
    renameFolder,
    deleteFolder,
    reorder,
  } = useBookmarks();
  const { tree } = useFileTree();
  const bookmarksSort = useTreeStore((s) => s.bookmarksSort);
  const { setBookmarksSort } = useWorkspace();
  const manualOrder = bookmarksSort === "manual";
  const { reveal } = useReveal();
  const { deleteNote } = useTreeMutations();
  const { toast } = useToast();
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<{
    noteId: string;
    notePath: string;
  } | null>(null);
  const [deleteNoteTarget, setDeleteNoteTarget] = useState<{
    noteId: string;
    name: string;
  } | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<{
    id: string;
    name: string;
    bookmarkCount: number;
  } | null>(null);
  const treeRef = useRef<TreeApi<ArboristNode> | null>(null);

  const resolveTitle = useCallback(
    (noteId: string): string =>
      (tree && findNoteTitle(tree.root, noteId)) ?? "Untitled",
    [tree],
  );

  const noteExists = useCallback(
    (noteId: string): boolean =>
      tree === null || findNoteTitle(tree.root, noteId) !== null,
    [tree],
  );

  const noteMeta = useMemo(
    () => (tree ? buildNoteMetaMap(tree.root) : new Map()),
    [tree],
  );
  const resolveMeta = useCallback(
    (noteId: string) => noteMeta.get(noteId),
    [noteMeta],
  );

  const data = useMemo(
    () =>
      adaptBookmarks(bookmarkFolders, bookmarks, resolveTitle, noteExists, {
        order: bookmarksSort,
        resolveMeta,
      }),
    [
      bookmarkFolders,
      bookmarks,
      resolveTitle,
      noteExists,
      bookmarksSort,
      resolveMeta,
    ],
  );

  // Bookmark folders start EXPANDED by default (pre-existing UX). TreeView's
  // underlying <Tree> defaults any node NOT covered by initialOpenState to
  // `openByDefault` — passed true below — so every currently-known folder
  // id being marked open here is really just for the FIRST paint; later
  // clicks flow through react-arborist's own open state via TreeRow's
  // node.toggle(), not this map.
  const initialOpenState = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const f of bookmarkFolders) out["bmfolder:" + f.id] = true;
    return out;
  }, [bookmarkFolders]);

  const handleActivate = useCallback((noteId: string) => {
    usePaneStore.getState().openInActivePane(noteId);
  }, []);

  const resolvePath = useCallback(
    (noteId: string): string => (tree && findNotePath(tree.root, noteId)) ?? "",
    [tree],
  );

  const folderOptions = useMemo(
    () => bookmarkFolders.map((f) => ({ id: f.id, name: f.name })),
    [bookmarkFolders],
  );

  /**
   * Find/Replace and the splits act on the bookmarked note, so both first open
   * it in the active pane — the sidebar has no editor of its own to target.
   */
  const bookmarkMenuActions = useCallback(
    (bookmarkId: string, noteId: string, title: string): BookmarkMenuActions => ({
      noteId,
      folders: folderOptions,
      onRequestRename: () => {
        revealInNavigation(noteId);
        useTreeStore.getState().startRename("note", noteId);
      },
      onMove: () => setMoveTarget({ noteId, notePath: resolvePath(noteId) }),
      onSplit: (dir) => usePaneStore.getState().openNoteInNewSplit(noteId, dir),
      onDelete: () =>
        setDeleteNoteTarget({
          noteId,
          name: basename(resolvePath(noteId)) || title,
        }),
      onRemoveBookmark: () => void toggleBookmark(noteId),
      onMoveToBookmarkFolder: (folderId) =>
        void moveToFolder(bookmarkId, folderId),
      onNewBookmarkFolder: () => setCreatingFolder(true),
      onOpenFind: () => {
        usePaneStore.getState().openInActivePane(noteId);
        requestFind("find");
      },
      onOpenFindReplace: () => {
        usePaneStore.getState().openInActivePane(noteId);
        requestFind("replace");
      },
      onRevealInFileManager: () => {
        void reveal(resolvePath(noteId));
      },
    }),
    [folderOptions, moveToFolder, resolvePath, reveal, toggleBookmark],
  );

  const folderMenuActions = useCallback(
    (folderId: string, name: string): BookmarkFolderMenuActions => ({
      onRename: () => setRenamingFolderId(folderId),
      onDelete: () =>
        setDeleteFolderTarget({
          id: folderId,
          name,
          bookmarkCount: bookmarks.filter((b) => b.folder_id === folderId)
            .length,
        }),
    }),
    [bookmarks],
  );

  const rowMenuOverrideFor = useCallback(
    (
      data: TreeRowData,
    ): { trigger: ReactNode; wrapRow?: (row: ReactNode) => ReactNode } | undefined => {
      if (data.kind === "bookmark") {
        const actions = bookmarkMenuActions(
          data.bookmarkId,
          data.noteId,
          data.title,
        );
        return {
          trigger: <BookmarkOptionsMenu {...actions} />,
          wrapRow: (row) => (
            <BookmarkRowContextMenu {...actions}>{row}</BookmarkRowContextMenu>
          ),
        };
      }
      if (data.kind === "bookmark-folder") {
        const actions = folderMenuActions(data.folderId, data.name);
        return {
          trigger: <BookmarkFolderOptionsMenu {...actions} />,
          wrapRow: (row) => (
            <BookmarkFolderContextMenu {...actions}>{row}</BookmarkFolderContextMenu>
          ),
        };
      }
      return undefined;
    },
    [bookmarkMenuActions, folderMenuActions],
  );

  const handleDeleteNoteConfirm = useCallback(async () => {
    if (deleteNoteTarget === null) return;
    try {
      await deleteNote(deleteNoteTarget.noteId);
    } catch {
      toast({ title: "Couldn't delete note. Try again.", variant: "error" });
    } finally {
      setDeleteNoteTarget(null);
    }
  }, [deleteNote, deleteNoteTarget, toast]);

  const handleDeleteFolderConfirm = useCallback(async () => {
    if (deleteFolderTarget === null) return;
    try {
      await deleteFolder(deleteFolderTarget.id);
    } finally {
      setDeleteFolderTarget(null);
    }
  }, [deleteFolder, deleteFolderTarget]);

  const handleCreateFolder = useCallback(
    async (name: string) => {
      await createFolder(name);
      setCreatingFolder(false);
    },
    [createFolder],
  );

  const noopSelectNote = useCallback(() => {
    /* bookmark rows activate via onActivate, never onSelectNote */
  }, []);

  /**
   * Resolves react-arborist's node args into plain ids and dispatches. The
   * cross-folder-vs-reorder decision lives in the pure, unit-tested
   * computeBookmarkMoveDispatch, so this stays a thin adapter.
   */
  const handleMove = useCallback(
    (args: {
      dragNodes: NodeApi<ArboristNode>[];
      parentNode: NodeApi<ArboristNode> | null;
      index: number;
    }) => {
      const destFolderId =
        args.parentNode?.data.data.kind === "bookmark-folder"
          ? args.parentNode.data.data.folderId
          : null;

      const draggedBookmarkIds = args.dragNodes
        .map((n) => n.data.data)
        .filter((d) => d.kind === "bookmark")
        .map((d) => (d as { bookmarkId: string }).bookmarkId);

      const dispatch = computeBookmarkMoveDispatch(
        bookmarks,
        draggedBookmarkIds,
        destFolderId,
        args.index,
      );

      if (dispatch.action === "moveToFolder") {
        for (const bookmarkId of dispatch.bookmarkIds) {
          void moveToFolder(bookmarkId, dispatch.folderId);
        }
      } else if (dispatch.action === "reorder") {
        void reorder(dispatch.folderId, dispatch.orderedIds);
      }
    },
    [bookmarks, moveToFolder, reorder],
  );

  /** Bookmarks never nest inside a bookmark leaf — only into a bookmark
   *  folder or the top level. */
  const disableDrop = useCallback(
    (args: { parentNode: NodeApi<ArboristNode> }): boolean =>
      args.parentNode.data.data.kind === "bookmark",
    [],
  );

  /** A sorted view would ignore any Order a drop wrote, so the affordance is
   *  withdrawn entirely outside Manual rather than accepted and discarded. */
  const disableDrag = useCallback(() => !manualOrder, [manualOrder]);

  /**
   * onRootDrop — drag-to-root. Fires when a bookmark is dropped in the
   * tree's empty area (react-arborist's
   * onMove never fires there — TreeView's window-level listener catches
   * it instead). Reuses the same moveToFolder(bookmarkId, null) mutation
   * the kebab's "(No folder)" entry already uses. Bookmarks already at
   * top level are skipped (no-op) rather than re-dispatching a move.
   */
  const handleRootDrop = useCallback(
    (dragNodes: NodeApi<ArboristNode>[]) => {
      const draggedBookmarkIds = dragNodes
        .map((n) => n.data.data)
        .filter((d) => d.kind === "bookmark")
        .map((d) => (d as { bookmarkId: string }).bookmarkId);

      for (const bookmarkId of draggedBookmarkIds) {
        const current = bookmarks.find((b) => b.id === bookmarkId);
        if (current && current.folder_id !== null) {
          void moveToFolder(bookmarkId, null);
        }
      }
    },
    [bookmarks, moveToFolder],
  );

  // Bordered 40px toolbar row — mirrors Sidebar.tsx's Notes-panel toolbar
  // chrome (same height/padding/borderBottom) so Bookmarks presents the same
  // panel-top interface as Notes.
  const header = (
    <div style={toolbarRowStyle}>
      <NewBookmarkFolderButton onClick={() => setCreatingFolder(true)} />
      <BookmarksSortMenu
        value={bookmarksSort}
        onSelect={(order) => void setBookmarksSort(order)}
      />
    </div>
  );

  const newFolderInput = creatingFolder && (
    <NewBookmarkFolderInput
      onCommit={handleCreateFolder}
      onCancel={() => setCreatingFolder(false)}
    />
  );

  if (error) {
    return (
      <div style={panelColumnStyle}>
        {header}
        {newFolderInput}
        <BookmarksErrorState onRetry={() => void refresh()} />
      </div>
    );
  }

  if (bookmarks.length === 0 && bookmarkFolders.length === 0) {
    return (
      <div style={panelColumnStyle}>
        {header}
        {newFolderInput}
        <BookmarksEmptyState />
      </div>
    );
  }

  return (
    <div style={panelColumnStyle} data-testid="bookmarks-panel">
      {header}
      {newFolderInput}
      <TreeView<ArboristNode>
        data={data}
        treeRef={treeRef}
        initialOpenState={initialOpenState}
        openByDefault
        onMove={manualOrder ? handleMove : undefined}
        disableDrop={disableDrop}
        disableDrag={disableDrag}
        onRootDrop={manualOrder ? handleRootDrop : undefined}
        renderRow={({ node, style, dragHandle }) => {
          const rowData = node.data;
          if (
            rowData.kind === "bookmark-folder" &&
            renamingFolderId === rowData.folderId
          ) {
            return (
              <div style={style}>
                <BookmarkFolderRenameInput
                  initialValue={rowData.name}
                  onCommit={async (name) => {
                    setRenamingFolderId(null);
                    await renameFolder(rowData.folderId, name);
                  }}
                  onCancel={() => setRenamingFolderId(null)}
                />
              </div>
            );
          }
          return (
            <TreeRow
              node={node}
              style={style}
              dragHandle={dragHandle}
              onSelectNote={noopSelectNote}
              onActivate={handleActivate}
              rowMenuOverride={rowMenuOverrideFor(rowData)}
            />
          );
        }}
      />
      {moveTarget !== null && (
        <MoveToFolderModal
          noteId={moveTarget.noteId}
          notePath={moveTarget.notePath}
          open
          onOpenChange={(next) => {
            if (!next) setMoveTarget(null);
          }}
        />
      )}
      {deleteNoteTarget !== null && (
        <DeleteConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setDeleteNoteTarget(null);
          }}
          target={{
            kind: "note",
            name: deleteNoteTarget.name,
            id: deleteNoteTarget.noteId,
          }}
          onConfirm={handleDeleteNoteConfirm}
        />
      )}
      {deleteFolderTarget !== null && (
        <DeleteConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setDeleteFolderTarget(null);
          }}
          target={{
            kind: "bookmark-folder",
            name: deleteFolderTarget.name,
            bookmarkCount: deleteFolderTarget.bookmarkCount,
          }}
          onConfirm={handleDeleteFolderConfirm}
        />
      )}
    </div>
  );
}
