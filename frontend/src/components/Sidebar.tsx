/**
 * Sidebar — layout shell: floating card with a 40px vault-name header, below
 * which either the FileTree or SidebarSearchPanel renders (LSIDE-02).
 *
 * Structure:
 *   <nav width=sidebarWidth>
 *     <card>
 *       <header>{vault display name} + SidebarToolbar</header>   (40px, shared chrome)
 *       {sidebarPanel === "files" ? <FileTree /> : <SidebarSearchPanel />}   (flex: 1; scrolls)
 *     </card>
 *     <SidebarResizeHandle />  (outside card — overlays the column boundary)
 *   </nav>
 *
 * The 40px header is shared chrome (D-15) — it does NOT swap when the panel
 * switches to Search; only the area below it does. `sidebarPanel` is driven
 * by the ribbon Files/Search toggle and Cmd+Shift+F (Plan 04). This panel
 * complements — never replaces — the existing Cmd+P/Cmd+Shift+F CommandMenu
 * palette, which still exists as a second, faster entry point into search.
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

import { FileTree } from "./FileTree";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { SidebarSearchPanel } from "./SidebarSearchPanel";
import { SidebarToolbar } from "./SidebarToolbar";
import type { Tree, TreeNode } from "../lib/treeApi";
import { useFileTree } from "../lib/useFileTree";
import { useTreeCreateActions } from "../lib/useTreeCreateActions";
import { useTreeStore, type SelectedRow } from "../lib/useTreeStore";
import { useVaultPicker } from "../lib/useVaultPicker";

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
  const { current } = useVaultPicker();
  const displayName = current?.display_name ?? "Notes";

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
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              lineHeight: 1.4,
              color: "var(--color-fg)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {displayName}
          </span>
          <SidebarToolbar
            onNewNote={handleNewNote}
            onNewFolder={handleNewFolder}
            creating={isCreating}
          />
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
          {sidebarPanel === "files" ? (
            <FileTree onSelectNote={onSelectNote} />
          ) : (
            <SidebarSearchPanel onSelectNote={onSelectNote} />
          )}
        </div>
        {/* Tag browser panel relocated to right-rail; left sidebar is file-tree-only. */}
      </div>
      {/* Outside the card — handle must overlay the outer nav's right edge, not the card's */}
      <SidebarResizeHandle />
    </nav>
  );
}
