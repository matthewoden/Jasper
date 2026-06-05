/**
 * TagBrowserSection — UI-SPEC §Surface 1.
 *
 * Collapsible sidebar section below the FileTree. Shows all tags with note
 * counts, sorted alphabetically. Clicking a tag sets activeTagFilter in
 * useTreeStore (which causes FileTree to swap into flat-list mode).
 *
 * Behaviors (locked, per Plan 06-08 Task 2):
 *   TB1: collapsed → only 32px header "▶ TAGS (N)"
 *   TB2: expanded → header (chevron down) + scrollable tag list (max 240px)
 *   TB3: clicking header toggles tagBrowserExpanded
 *   TB4: rows alphabetical, name left, count badge right
 *   TB5: clicking row → setActiveTagFilter(tagName)
 *   TB6: hover bg = color-mix(in srgb, var(--color-fg) 4%, transparent)
 *   TB7: active row = accent-tinted bg + accent text
 *   TB8: right-click → ContextMenu with Rename + Remove
 *   TB9: Rename → inline RenameInput → Enter commits via renameTag
 *   TB10: Remove with N ≤ 5 → silent deleteTag
 *   TB11: Remove with N > 5 → TagDeleteConfirmDialog
 *   TB12: empty state copy "No tags yet. Add tags: [] to a note's frontmatter."
 *   TB13: aria-expanded + aria-controls on header button
 *
 * Security (T-06-08-01): client pre-validates tag name against /^[a-z0-9_-]+$/
 * before calling renameTag — server is authoritative but we block the submit
 * for UX.
 */
import { useState, useId, type CSSProperties } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";

import { useTreeStore } from "../lib/useTreeStore";
import { useTagBrowser } from "../lib/useTagBrowser";
import { renameTag, deleteTag } from "../lib/tagsApi";
import { TagDeleteConfirmDialog } from "./TagDeleteConfirmDialog";
import { RenameInput } from "./RenameInput";
import { useToast } from "./toast.utils";


const sectionStyle: CSSProperties = {
  borderTop: "1px solid var(--color-border)",
  background: "var(--color-surface)",
  display: "flex",
  flexDirection: "column",
};

const headerStyle: CSSProperties = {
  height: 32,
  padding: "0 16px",
  background: "var(--color-surface)",
  display: "flex",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
  border: "none",
  width: "100%",
  textAlign: "left",
  outline: "none",
  userSelect: "none",
};

const headerLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-muted)",
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  lineHeight: 1.4,
  flex: 1,
};

const listStyle: CSSProperties = {
  maxHeight: 240,
  overflowY: "auto",
  padding: "4px 0",
  listStyle: "none",
  margin: 0,
};

const rowBaseStyle: CSSProperties = {
  height: 32,
  display: "flex",
  alignItems: "center",
  padding: "0 8px 0 16px",
  gap: 8,
  cursor: "pointer",
  border: "none",
  background: "transparent",
  width: "100%",
  textAlign: "left",
  outline: "none",
  userSelect: "none",
};

const tagNameStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 400,
  color: "var(--color-fg)",
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const tagNameActiveStyle: CSSProperties = {
  ...tagNameStyle,
  color: "var(--color-accent)",
};

const countBadgeStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 400,
  color: "var(--color-muted)",
  flexShrink: 0,
};

const emptyStateStyle: CSSProperties = {
  padding: "12px 16px",
  fontSize: 12,
  fontWeight: 400,
  color: "var(--color-muted)",
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
  fontSize: 14,
  fontWeight: 400,
  color: "var(--color-fg)",
  cursor: "pointer",
  outline: "none",
  userSelect: "none",
};

const destructiveItemStyle: CSSProperties = {
  ...menuItemStyle,
  color: "var(--color-destructive)",
};


const TAG_CHARSET_REGEX = /^[a-z0-9_-]+$/;

export function TagBrowserSection() {
  const expanded = useTreeStore((s) => s.tagBrowserExpanded);
  const setExpanded = useTreeStore((s) => s.setTagBrowserExpanded);
  const activeTagFilter = useTreeStore((s) => s.activeTagFilter);
  const setActiveTagFilter = useTreeStore((s) => s.setActiveTagFilter);
  const { tags, refresh } = useTagBrowser();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    name: string;
    count: number;
  } | null>(null);
  const listId = useId();
  const { toast } = useToast();

  const sortedTags = [...tags].sort((a, b) => a.name.localeCompare(b.name));

  const handleRenameCommit = async (oldName: string, newName: string) => {
    if (!TAG_CHARSET_REGEX.test(newName)) {
      throw new Error(
        "Tag names may only contain lowercase letters, digits, hyphens, and underscores.",
      );
    }
    try {
      const result = await renameTag(oldName, newName);
      setRenaming(null);
      await refresh();
      if (activeTagFilter === oldName) {
        setActiveTagFilter(newName);
      }
      if (result.touched_note_ids.length > 5) {
        toast({
          title: "Tag renamed",
          description: `Updated ${result.touched_note_ids.length} notes — "${oldName}" → "${newName}"`,
          variant: "info",
        });
      }
    } catch (e) {
      throw e instanceof Error ? e : new Error("Rename failed");
    }
  };

  const handleDeleteClick = (tag: { name: string; count: number }) => {
    if (tag.count <= 5) {
      void (async () => {
        try {
          await deleteTag(tag.name);
          if (activeTagFilter === tag.name) {
            setActiveTagFilter(null);
          }
          await refresh();
        } catch {
          toast({
            title: "Tag rewrite failed",
            description: `"${tag.name}" could not be removed. The change has been rolled back.`,
            variant: "error",
          });
        }
      })();
    } else {
      setConfirming({ name: tag.name, count: tag.count });
    }
  };

  const handleConfirmDelete = async () => {
    if (!confirming) return;
    try {
      const result = await deleteTag(confirming.name);
      if (activeTagFilter === confirming.name) {
        setActiveTagFilter(null);
      }
      await refresh();
      setConfirming(null);
      if (result.touched_note_ids.length > 5) {
        toast({
          title: "Tag removed",
          description: `Removed "${confirming.name}" from ${result.touched_note_ids.length} notes`,
          variant: "info",
        });
      }
    } catch {
      setConfirming(null);
      toast({
        title: "Tag rewrite failed",
        description: `"${confirming.name}" could not be removed. The change has been rolled back.`,
        variant: "error",
      });
    }
  };

  const ariaLabel = expanded
    ? `Tags section, expanded. ${tags.length} tags. Click to collapse.`
    : `Tags section, collapsed. ${tags.length} tags. Click to expand.`;

  return (
    <>
      <div style={sectionStyle}>
        {/* Section header */}
        <button
          type="button"
          style={headerStyle}
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={ariaLabel}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDown size={14} color="var(--color-muted)" />
          ) : (
            <ChevronRight size={14} color="var(--color-muted)" />
          )}
          <span style={headerLabelStyle}>TAGS ({tags.length})</span>
        </button>

        {/* Tag list (shown only when expanded) */}
        {expanded && (
          <ul id={listId} role="list" style={listStyle}>
            {sortedTags.length === 0 ? (
              <li style={emptyStateStyle}>
                No tags yet. Add tags: [] to a note&apos;s frontmatter.
              </li>
            ) : (
              sortedTags.map((tag) => {
                const isActive = activeTagFilter === tag.name;
                const isRenaming = renaming === tag.name;

                return (
                  <li key={tag.name} role="listitem">
                    <ContextMenu.Root>
                      <ContextMenu.Trigger asChild>
                        <button
                          type="button"
                          data-testid={`tag-row-${tag.name}`}
                          data-active={isActive ? "true" : "false"}
                          style={{
                            ...rowBaseStyle,
                            background: isActive
                              ? "color-mix(in srgb, var(--color-accent) 8%, transparent)"
                              : undefined,
                          }}
                          onClick={() => {
                            if (!isRenaming) {
                              setActiveTagFilter(tag.name);
                            }
                          }}
                          onMouseEnter={(e) => {
                            if (!isActive) {
                              (e.currentTarget as HTMLButtonElement).style.background =
                                "color-mix(in srgb, var(--color-fg) 4%, transparent)";
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!isActive) {
                              (e.currentTarget as HTMLButtonElement).style.background =
                                "transparent";
                            }
                          }}
                        >
                          {isRenaming ? (
                            <RenameInput
                              initialValue={tag.name}
                              isFolder={false}
                              siblingNames={tags
                                .map((t) => t.name)
                                .filter((n) => n !== tag.name)}
                              onCommit={async (newName) => {
                                await handleRenameCommit(tag.name, newName);
                              }}
                              onCancel={() => setRenaming(null)}
                              isNew={false}
                            />
                          ) : (
                            <>
                              <span
                                style={
                                  isActive ? tagNameActiveStyle : tagNameStyle
                                }
                              >
                                {tag.name}
                              </span>
                              <span style={countBadgeStyle}>{tag.count}</span>
                            </>
                          )}
                        </button>
                      </ContextMenu.Trigger>
                      <ContextMenu.Portal>
                        <ContextMenu.Content style={menuContainerStyle}>
                          <ContextMenu.Item
                            style={menuItemStyle}
                            onSelect={() => setRenaming(tag.name)}
                          >
                            Rename tag…
                          </ContextMenu.Item>
                          <ContextMenu.Item
                            style={destructiveItemStyle}
                            data-testid={`delete-tag-${tag.name}`}
                            onSelect={() => handleDeleteClick(tag)}
                          >
                            {`Remove from ${tag.count} notes…`}
                          </ContextMenu.Item>
                        </ContextMenu.Content>
                      </ContextMenu.Portal>
                    </ContextMenu.Root>
                  </li>
                );
              })
            )}
          </ul>
        )}
      </div>

      {/* Tag delete confirmation dialog (shown for N > 5) */}
      <TagDeleteConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        tagName={confirming?.name ?? ""}
        noteCount={confirming?.count ?? 0}
        onConfirm={() => void handleConfirmDelete()}
      />
    </>
  );
}
