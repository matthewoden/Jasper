/**
 * Breadcrumbs — renders the active note's path as a clickable trail.
 *
 * Folder segments expand + scroll the file tree on click. Final note-title
 * segment uses liveLabels[activeNoteId] so it updates within ~500ms of an H1
 * edit (same source as the tree row label).
 */
import React from "react";
import type { CSSProperties } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { FolderOpen } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";
import { useFileTree } from "../lib/useFileTree";
import { useReveal } from "../lib/useReveal";
import { expandAndScrollToFolder } from "./fileTree.utils";
import type { TreeNode } from "../lib/treeApi";


interface Segment {
  /** Display label for this segment. */
  label: string;
  /** Folder path used to call expandAndScrollToFolder; null for the title segment. */
  path: string | null;
  /** True only for the final note-title segment. */
  isTitle?: boolean;
}


/**
 * findNoteById walks Tree.root to find the note matching `id`.
 * Returns { path, title } or null if not found.
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
 * buildSegments converts a note filesystem path to an ordered segment array.
 * The vault root is the implicit context; no leading "notes" segment is shown.
 */
function buildSegments(notePath: string, displayTitle: string): Segment[] {
  const parts = notePath.split("/").filter(Boolean);
  const segments: Segment[] = [];

  for (let i = 0; i < parts.length - 1; i++) {
    const folderPath = parts.slice(0, i + 1).join("/");
    segments.push({ label: parts[i], path: folderPath });
  }

  const titleLabel =
    displayTitle ||
    parts[parts.length - 1]?.replace(/\.md$/i, "") ||
    "Untitled";
  segments.push({ label: titleLabel, path: null, isTitle: true });

  return segments;
}


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


export function Breadcrumbs(): React.ReactElement | null {
  const activeNoteId = useTreeStore((s) => s.activeNoteId);
  const liveTitle = useTreeStore((s) =>
    activeNoteId ? (s.liveLabels?.[activeNoteId] ?? "") : "",
  );
  const { tree } = useFileTree();
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
            <ContextMenu.Root>
              <ContextMenu.Trigger asChild>
                <button
                  type="button"
                  aria-label={`Navigate to folder: ${seg.label}`}
                  onClick={() => {
                    expandAndScrollToFolder(seg.path!);
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
