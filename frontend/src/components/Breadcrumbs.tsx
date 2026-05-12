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
import { useTreeStore } from "../lib/useTreeStore";
import { useFileTree } from "../lib/useFileTree";
import { expandAndScrollToFolder } from "./FileTree";
import type { TreeNode } from "../lib/treeApi";

// ──────────────────────────────────────────────────────────────────────
// Internal types
// ──────────────────────────────────────────────────────────────────────

interface Segment {
  /** Display label for this segment. */
  label: string;
  /** Folder path used to call expandAndScrollToFolder; null for root + title. */
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
 *   { label: "notes", path: null },
 *   { label: "projects", path: "projects" },
 *   { label: "jasper",   path: "projects/jasper" },
 *   { label: "my-note",  path: null, isTitle: true },  // uses displayTitle
 * ]
 */
function buildSegments(notePath: string, displayTitle: string): Segment[] {
  const parts = notePath.split("/").filter(Boolean);
  const segments: Segment[] = [{ label: "notes", path: null }];

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

const rootSpanStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 400,
  color: "var(--color-muted)",
  whiteSpace: "nowrap",
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

// ──────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────

export function Breadcrumbs(): React.ReactElement | null {
  const activeNoteId = useTreeStore((s) => s.activeNoteId);
  const liveTitle = useTreeStore((s) =>
    activeNoteId ? (s.liveLabels?.[activeNoteId] ?? "") : "",
  );
  const { tree } = useFileTree();

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
          ) : seg.path ? (
            <button
              type="button"
              aria-label={`Navigate to folder: ${seg.label}`}
              onClick={() => expandAndScrollToFolder(seg.path!)}
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
          ) : (
            <span style={rootSpanStyle}>{seg.label}</span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}
