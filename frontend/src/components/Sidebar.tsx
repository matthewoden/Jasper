/**
 * Sidebar — layout shell: floating card with a 40px header hosting the
 * SidebarTabRow (Notes/Search/Bookmarks icon tabs + collapse control), below
 * which one of FileTree / SidebarSearchPanel / BookmarksPanel renders
 * (Phase 27 NAV-01/NAV-03).
 *
 * Structure:
 *   <nav width=sidebarWidth>
 *     <card>
 *       <header><SidebarTabRow /></header>   (40px, shared chrome — same header for every panel)
 *       {sidebarPanel === "notes" ? <SidebarToolbar/> + <FileTree/> : sidebarPanel === "search" ? <SidebarSearchPanel/> : <BookmarksPanel/>}   (flex: 1; scrolls)
 *     </card>
 *     <SidebarResizeHandle />  (outside card — overlays the column boundary)
 *   </nav>
 *
 * The 40px header is shared chrome — it does NOT swap when the panel
 * switches; only the area below it does. `sidebarPanel` is driven by
 * SidebarTabRow's tab clicks and Cmd+Shift+F. This panel complements — never
 * replaces — the existing Cmd+P/Cmd+Shift+F CommandMenu palette, which still
 * exists as a second, faster entry point into search.
 *
 * SidebarToolbar (New note / New folder) moved from the shared header down
 * to the Notes panel's own top edge — it is note-scoped chrome, not global,
 * and the shared header no longer has room for it once the tab row + collapse
 * control occupy it (Phase 27 D-07 / Task 2 discretion).
 *
 * Toolbar wiring:
 *   - New note / New folder → useTreeCreateActions().createNoteAt/FolderAt(parent),
 *     where parent comes from useTreeStore.selectedRow via parentPathForCreate().
 *     Folder ⇒ create inside; note ⇒ create in its parent folder; none ⇒ root ("").
 *     The new node immediately enters inline-rename mode.
 *   - isCreating (from useTreeCreateActions) threads through to SidebarToolbar
 *     to visibly disable the buttons while a create is in flight.
 */
import { useCallback } from "react";
import type React from "react";
import { ChevronsDownUp } from "lucide-react";

import { BookmarksPanel } from "./BookmarksPanel";
import { FileTree } from "./FileTree";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { SidebarSearchPanel } from "./SidebarSearchPanel";
import { SidebarTabRow } from "./SidebarTabRow";
import { SidebarToolbar } from "./SidebarToolbar";
import type { Tree, TreeNode } from "../lib/treeApi";
import { useFileTree } from "../lib/useFileTree";
import { useTreeCreateActions } from "../lib/useTreeCreateActions";
import { useTreeStore, type SelectedRow } from "../lib/useTreeStore";

export interface SidebarProps {
  onSelectNote?: (id: string) => void;
  /** Optional style for grid placement; merged onto the outer nav. */
  style?: React.CSSProperties;
}

/**
 * Derive the create-target parent path from the currently selected row.
 *   - folder → create inside that folder
 *   - note   → create in the note's parent folder
 *   - none   → root ("")
 */
function parentPathForCreate(
  tree: Tree | null,
  sr: SelectedRow | null,
): string {
  if (!sr) return "";
  if (sr.kind === "folder") return sr.target;
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
    if (node.kind !== "folder") return null;
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

export function Sidebar({ onSelectNote = () => {}, style }: SidebarProps) {
  const { tree } = useFileTree();
  const { createNoteAt, createFolderAt, isCreating } = useTreeCreateActions();
  const sidebarWidth = useTreeStore((s) => s.sidebarWidth);
  const notesSidebarVisible = useTreeStore((s) => s.notesSidebarVisible);
  const sidebarPanel = useTreeStore((s) => s.sidebarPanel);

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

  if (!notesSidebarVisible) return null;

  return (
    <nav
      style={{
        width: sidebarWidth,
        height: "100%",
        background: "var(--color-bg)",
        position: "relative",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        ...style,
      }}
      aria-label="Notes navigation"
    >
      {/* Flush panel — border-right only, matching the mock's file-tree rail (D-06 owner-approved 23-03) */}
      <div
        style={{
          flex: 1,
          background: "var(--color-surface)",
          borderRight: "1px solid var(--color-border)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <header
          className="flex items-center justify-between"
          style={{
            height: 40,
            paddingLeft: 16,
            paddingRight: 16,
            borderBottom: "1px solid var(--color-border)",
            flexShrink: 0,
          }}
        >
          <SidebarTabRow />
        </header>
        {/*
          Tree-area shell — overflow:hidden because react-arborist's
          internal react-window FixedSizeList owns the scroll surface.
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
          {sidebarPanel === "notes" ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                minHeight: 0,
              }}
            >
              {/*
                Notes-panel toolbar row — mock parity (Vault.dc.html §left
                panel): a bordered 40px row with New note / New folder on the
                left and Collapse-all on the right. New note / New folder are
                note-scoped chrome (not global), so they live here rather than
                the shared tab-row header (Phase 27 D-07). The sort-order menu
                the mock also shows in this row is Phase 29 scope (SORT-01).
              */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  height: 40,
                  padding: "0 8px",
                  borderBottom: "1px solid var(--color-border)",
                  flexShrink: 0,
                }}
              >
                <SidebarToolbar
                  onNewNote={handleNewNote}
                  onNewFolder={handleNewFolder}
                  creating={isCreating}
                />
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  title="Collapse all"
                  aria-label="Collapse all"
                  onClick={() => useTreeStore.getState().collapseAllFolders()}
                  style={{
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
                  }}
                >
                  <ChevronsDownUp size={16} aria-hidden="true" />
                </button>
              </div>
              {/* display:flex + column so FileTree's flex:1 tree-area actually
                  stretches to fill (its ResizeObserver-measured height drives
                  react-arborist's virtual list — without this it collapses to a
                  fixed ~400px and the note list stops short of the bottom). */}
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  position: "relative",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <FileTree onSelectNote={onSelectNote} />
              </div>
            </div>
          ) : sidebarPanel === "search" ? (
            <SidebarSearchPanel onSelectNote={onSelectNote} />
          ) : (
            <BookmarksPanel onSelectNote={onSelectNote} />
          )}
        </div>
        {/* Tag browser panel relocated to right-rail; left sidebar is file-tree-only. */}
      </div>
      {/* Outside the card — handle must overlay the outer nav's right edge, not the card's */}
      <SidebarResizeHandle />
    </nav>
  );
}
