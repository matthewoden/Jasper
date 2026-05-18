/**
 * Breadcrumbs — Phase 06.6-07 (UX-CHROME-01)
 *
 * Renders the active note's path as a breadcrumb trail:
 *   notes / folder / subfolder / note-title
 *
 * - Root "notes" segment: informational span, muted color.
 * - Folder segments: <button> with aria-label, calls expandAndScrollToFolder
 *   on click (expands + scrolls the file tree to that folder and ensures
 *   the sidebar is visible).
 * - Final note-title segment: <span> (not clickable), bold, shows live title
 *   from useTreeStore.liveLabels[activeNoteId] (same source as the tab title
 *   and the tree row label, updated within ~500ms of an H1 edit).
 *
 * Designed for use in the TopBar (Plan 09).
 */
import React from "react";
import type { CSSProperties } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { FolderOpen } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";
import { useFileTree } from "../lib/useFileTree";
import { useReveal } from "../lib/useReveal";
import { expandAndScrollToFolder } from "./FileTree";
import type { TreeNode } from "../lib/treeApi";

// ──────────────────────────────────────────────────────────────────────
// Internal types
// ──────────────────────────────────────────────────────────────────────

interface Segment {
  /** Display label for this segment. */
  label: string;
  /** Folder path used to call expandAndScrollToFolder; null for the title segment. */
  path: string | null;
  /** True only for the final note-title segment. */
  isTitle?: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Pure helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Walk the wire tree (Tree.root) to find the note matching `id`.
 * Returns { path, title } or null if not found.
 *
 * Tree node shapes (from generated schema):
 *   FolderNode: { kind:"folder", path, name, children?: TreeNode[] }
 *   NoteNode:   { kind:"note", id, path, title, updated_at }
 */
function findNoteById(
  nodes: ReadonlyArray<TreeNode>,
  id: string,
): { path: string; title: string } | null {
  for (const node of nodes) {
    if (node.kind === "note" && node.id === id) {
      return { path: node.path, title: node.title };
    }
    if (node.kind === "folder" && Array.isArray(node.children)) {
      const found = findNoteById(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Build the ordered segment array from a note's filesystem path.
 *
 * Example: "projects/jasper/my-note.md" → [
 *   { label: "projects", path: "projects" },
 *   { label: "jasper",   path: "projects/jasper" },
 *   { label: "my-note",  path: null, isTitle: true },  // uses displayTitle
 * ]
 *
 * UAT follow-up 2026-05-12: dropped the leading "notes" root segment — the
 * notes vault is the implicit root of the entire app, not a real section to
 * navigate to.
 */
function buildSegments(notePath: string, displayTitle: string): Segment[] {
  const parts = notePath.split("/").filter(Boolean);
  const segments: Segment[] = [];

  // Folder segments — every part except the last (the filename).
  for (let i = 0; i < parts.length - 1; i++) {
    const folderPath = parts.slice(0, i + 1).join("/");
    segments.push({ label: parts[i], path: folderPath });
  }

  // Final title segment — use the live/static display title, not the raw filename.
  const titleLabel =
    displayTitle ||
    parts[parts.length - 1]?.replace(/\.md$/i, "") ||
    "Untitled";
  segments.push({ label: titleLabel, path: null, isTitle: true });

  return segments;
}

// ──────────────────────────────────────────────────────────────────────
// Styles (inline — consistent with the rest of the project's style approach)
// ──────────────────────────────────────────────────────────────────────

const containerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  overflow: "hidden",
  flex: 1,
  minWidth: 0,
};

const separatorStyle: CSSProperties = {
  color: "var(--color-muted)",
  fontSize: 14,
  margin: "0 2px",
  flexShrink: 0,
};

const folderButtonStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 400,
  color: "var(--color-fg)",
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: 0,
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const titleSpanStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--color-fg)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

// Plan 08-06 (D-26 / SHARE-01 Mount B): "Show in file manager" context
// menu for each folder segment. Style values mirror TreeRowMenu.tsx
// (menuContainerStyle + itemStyle around lines 59-83) so the visual
// language stays consistent across the four reveal mount points. We
// duplicate rather than import to avoid an unwanted style export
// surface on TreeRowMenu.tsx.
const menuContainerStyle: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  paddingTop: 4,
  paddingBottom: 4,
  minWidth: 200,
  maxWidth: 320,
  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
  zIndex: 50,
};

const menuItemStyle: CSSProperties = {
  height: 32,
  display: "flex",
  alignItems: "center",
  padding: "0 16px",
  gap: 8,
  fontSize: 14,
  fontWeight: 400,
  color: "var(--color-fg)",
  cursor: "pointer",
  outline: "none",
  userSelect: "none",
};

// ──────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────

export function Breadcrumbs(): React.ReactElement | null {
  const activeNoteId = useTreeStore((s) => s.activeNoteId);
  const liveTitle = useTreeStore((s) =>
    activeNoteId ? (s.liveLabels?.[activeNoteId] ?? "") : "",
  );
  const { tree } = useFileTree();
  // Plan 08-06 (D-26 / SHARE-01 Mount B): shared reveal hook for the
  // folder-segment context menu. Single dispatch, LOCKED toast copy.
  const { reveal } = useReveal();

  if (!activeNoteId) return null;

  const note = findNoteById(tree?.root ?? [], activeNoteId);
  if (!note) return null;

  const displayTitle =
    liveTitle ||
    note.title ||
    note.path.split("/").pop()?.replace(/\.md$/i, "") ||
    "Untitled";

  const segments = buildSegments(note.path, displayTitle);

  return (
    <nav aria-label="Note path" style={containerStyle}>
      {segments.map((seg, i) => (
        <React.Fragment key={`${seg.path ?? "root"}:${seg.label}:${i}`}>
          {i > 0 && (
            <span aria-hidden="true" style={separatorStyle}>
              /
            </span>
          )}
          {seg.isTitle ? (
            <span style={titleSpanStyle}>{seg.label}</span>
          ) : (
            // Plan 08-06 (D-26 / SHARE-01 Mount B): each folder-segment
            // <button> becomes a Radix ContextMenu.Trigger. Right-click
            // surfaces a 1-item menu "Show in file manager"; left-click
            // still expands/scrolls the tree (existing behavior). The
            // menu items use the same visual treatment as TreeRowMenu's
            // itemStyle (32px row, 14px regular, --color-fg) per UI-SPEC
            // §Surface 4 — researcher pinned the icon-included variant
            // for visual scan.
            <ContextMenu.Root>
              <ContextMenu.Trigger asChild>
                <button
                  type="button"
                  aria-label={`Navigate to folder: ${seg.label}`}
                  onClick={() => {
                    expandAndScrollToFolder(seg.path!);
                    // UAT follow-up 2026-05-12: brief pulse on the target row.
                    useTreeStore
                      .getState()
                      .setPulseTarget({ kind: "folder", target: seg.path! });
                    window.setTimeout(() => {
                      const cur = useTreeStore.getState().pulseTarget;
                      if (cur && cur.kind === "folder" && cur.target === seg.path) {
                        useTreeStore.getState().setPulseTarget(null);
                      }
                    }, 900);
                  }}
                  style={folderButtonStyle}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.color = "var(--color-accent)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.color = "var(--color-fg)")
                  }
                >
                  {seg.label}
                </button>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content style={menuContainerStyle}>
                  <ContextMenu.Item
                    style={menuItemStyle}
                    aria-label={`Show ${seg.label} in file manager`}
                    onSelect={() => {
                      if (seg.path) void reveal(seg.path);
                    }}
                  >
                    <FolderOpen size={16} aria-hidden="true" />
                    <span>Show in file manager</span>
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}
