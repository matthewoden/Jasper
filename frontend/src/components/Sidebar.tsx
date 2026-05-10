/**
 * Phase 3 sidebar — replaces the Phase 1 hardcoded single-row stub.
 *
 * Structure (UI-SPEC §Sidebar internal structure):
 *   <nav width=260>
 *     <header>NOTES + SidebarToolbar</header>
 *     <FileTree onSelectNote={...} />   (flex: 1; scrolls)
 *   </nav>
 *
 * State ownership: useFileTree owns tree state; useTreeStore owns
 * activeNoteId + expanded. Sidebar itself is a layout shell with
 * toolbar wiring:
 *   - New note / New folder click → useTreeCreateActions().createNoteAt(parent)
 *     / .createFolderAt(parent), where `parent` is derived from
 *     useTreeStore.selectedRow via the parentPathForCreate() helper below
 *     (Plan 05.5-06, UX-12). Folder selection ⇒ create inside the folder;
 *     note selection ⇒ create alongside the note (in its parent folder);
 *     no selection ⇒ root (""). The new node immediately enters
 *     inline-rename mode (useTreeCreateActions calls startRename on the
 *     POST response).
 *   - Refresh click → postAdminReindex("incremental"). On error, surface
 *     the locked toast tuple per UI-SPEC §Surface 5
 *     ("Couldn't refresh the index.") AND re-throw so the toolbar's
 *     spin-disabled treatment clears.
 *   - Gap R2-2: while a create is in flight, the toolbar's New Note +
 *     New Folder buttons are visibly disabled — see
 *     `useTreeCreateActions.isCreating`. The flag is threaded straight
 *     through to `<SidebarToolbar creating=... />`.
 */
import { useCallback } from "react";

import { FileTree } from "./FileTree";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { SidebarToolbar } from "./SidebarToolbar";
import { useToast } from "./Toast";
import { postAdminReindex } from "../lib/adminApi";
import type { Tree, TreeNode } from "../lib/treeApi";
import { useFileTree } from "../lib/useFileTree";
import { useTreeCreateActions } from "../lib/useTreeCreateActions";
import { useTreeStore, type SelectedRow } from "../lib/useTreeStore";

export interface SidebarProps {
  onSelectNote?: (id: string) => void;
}

/**
 * UX-12: derive the create target parent path from the currently selected
 * row.
 *   - folder selection → create inside that folder (target = folder.path)
 *   - note selection   → create in the note's parent folder
 *   - no selection     → root ("")
 *
 * The Tree shape uses `tree.root` (NoteNode | FolderNode array). Mirror
 * EditorPane.findNotePathInTree (EditorPane.tsx line 139) for the note →
 * path lookup.
 */
function parentPathForCreate(
  tree: Tree | null,
  sr: SelectedRow | null,
): string {
  if (!sr) return "";
  if (sr.kind === "folder") return sr.target;
  // sr.kind === "note": sr.target is the note id; walk the tree to find
  // its path, then take the parent dir. Fall back to root if the note
  // can't be found (e.g., tree hasn't loaded yet OR the selected note
  // was just deleted from a sibling surface).
  const path = findNotePathById(tree, sr.target);
  if (path === null) return "";
  return parentDirOf(path);
}

function parentDirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function findNotePathById(tree: Tree | null, id: string): string | null {
  if (tree === null) return null;
  const visit = (node: TreeNode): string | null => {
    if (node.kind === "note") {
      return node.id === id ? node.path : null;
    }
    if (node.children) {
      for (const child of node.children) {
        const hit = visit(child);
        if (hit !== null) return hit;
      }
    }
    return null;
  };
  for (const node of tree.root) {
    const hit = visit(node);
    if (hit !== null) return hit;
  }
  return null;
}

export function Sidebar({ onSelectNote = () => {} }: SidebarProps) {
  const { tree, refresh } = useFileTree();
  const { createNoteAt, createFolderAt, isCreating } = useTreeCreateActions();
  const { toast } = useToast();
  // Phase 5.5 — Plan 05 (UX-09): width comes from the store; resize handle
  // mounts as the last child of <nav> so it overlays the FileTree's
  // overflow:auto container.
  const sidebarWidth = useTreeStore((s) => s.sidebarWidth);

  const handleRefresh = useCallback(async () => {
    const { error } = await postAdminReindex("incremental");
    if (error) {
      const message =
        typeof error === "string"
          ? error
          : ((error as { message?: string }).message ?? "Try again.");
      toast({
        title: "Couldn't refresh the index.",
        description: message,
        variant: "error",
      });
      // Re-throw so the toolbar's catch clears the spin-disabled
      // treatment and the user can immediately try again.
      throw new Error(message);
    }
    await refresh();
  }, [refresh, toast]);

  // UX-12: toolbar New note / New folder target the parent of the currently
  // selected row (or inside the selected folder). Falls back to root only
  // when no row has been selected. selectedRow is read via getState() at
  // click time — NOT subscribed — so the Sidebar doesn't re-render on
  // every selection change. This matches Plan 03-20's pattern (App.tsx's
  // document-level F2 listener also reads selectedRow via getState()).
  const handleNewNote = useCallback(() => {
    const sr = useTreeStore.getState().selectedRow;
    const parent = parentPathForCreate(tree, sr);
    void createNoteAt(parent);
  }, [createNoteAt, tree]);

  const handleNewFolder = useCallback(() => {
    const sr = useTreeStore.getState().selectedRow;
    const parent = parentPathForCreate(tree, sr);
    void createFolderAt(parent);
  }, [createFolderAt, tree]);

  return (
    <nav
      className="bg-surface border-r border-border h-full flex flex-col"
      style={{ width: sidebarWidth, position: "relative" }}
      aria-label="Notes navigation"
    >
      <header
        className="flex items-center justify-between"
        style={{
          height: 32,
          paddingLeft: 16,
          paddingRight: 16,
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <span
          className="text-muted uppercase font-semibold"
          style={{
            fontSize: 12,
            letterSpacing: "0.05em",
            lineHeight: 1.4,
          }}
        >
          NOTES
        </span>
        <SidebarToolbar
          onNewNote={handleNewNote}
          onNewFolder={handleNewFolder}
          onRefresh={handleRefresh}
          creating={isCreating}
        />
      </header>
      {/*
        Tree-area shell — bounded by viewport (parent grid row is
        minmax(0, 1fr)). overflow:hidden because react-arborist's
        internal react-window FixedSizeList owns the scroll surface;
        delegating overflow here used to let the sidebar render a
        9999px scrollable area (Tree height={9999} hack), which pushed
        a giant useless scrollbar past the actual content.
      */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
        <FileTree onSelectNote={onSelectNote} />
      </div>
      {/* Phase 5.5 — Plan 05 (UX-09): MUST be the last child so the
          absolute-positioned handle overlays the FileTree scroll
          container. The parent <nav> sets position: "relative" above. */}
      <SidebarResizeHandle />
    </nav>
  );
}
