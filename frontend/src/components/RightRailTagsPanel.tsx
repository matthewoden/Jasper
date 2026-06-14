/**
 * RightRailTagsPanel — tag browser in the right rail.
 *
 * Differences from the legacy left-sidebar TagBrowserSection:
 *   - Uses `rightRailTagsPanelExpanded` store slice
 *   - Header: `Tags (N)` title-case
 *   - Case-insensitive substring filter input; query resets on note switch
 *   - List uses `flex: 1` to fill the panel card (no fixed maxHeight)
 *   - Floating panel card shell: borderRadius 8px, 1px border, --color-surface bg
 *
 * Filter query is bound via `value=` only — never via dangerouslySetInnerHTML.
 * TagBrowserSection.tsx is left in the repo as dead code; this is the active impl.
 */
import { useState, useEffect, useId, type CSSProperties } from "react";

import { X } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";

import { useTreeStore } from "../lib/useTreeStore";
import { useTagBrowser } from "../lib/useTagBrowser";
import { renameTag, deleteTag } from "../lib/tagsApi";
import { TagDeleteConfirmDialog } from "./TagDeleteConfirmDialog";
import { RenameInput } from "./RenameInput";
import { useToast } from "./toast.utils";


/** Panel card shell — shared treatment per Surface 1-NEW. */
const panelCardStyle: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  height: "100%",
};

/** Panel header container — flex row; houses expand-toggle + × close button */
const headerStyle: CSSProperties = {
  height: 32,
  padding: "0 4px 0 12px",
  background: "var(--color-surface)",
  display: "flex",
  alignItems: "center",
  gap: 4,
  borderBottom: "1px solid var(--color-border)",
  flexShrink: 0,
};

/** × close button (right portion of header) */
const closeButtonStyle: CSSProperties = {
  padding: 4,
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "var(--color-muted)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 3,
  flexShrink: 0,
};

const headerLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-muted)",
  lineHeight: 1.4,
  flex: 1,
};

/** Tag list: flex-1 fills panel card height. */
const listStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
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


const emptyStateStyle: CSSProperties = {
  padding: "12px 16px",
  fontSize: 12,
  fontWeight: 400,
  color: "var(--color-muted)",
  textAlign: "center",
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

export function RightRailTagsPanel() {
  const activeTagFilter = useTreeStore((s) => s.activeTagFilter);
  const setActiveTagFilter = useTreeStore((s) => s.setActiveTagFilter);
  const activeNoteId = useTreeStore((s) => s.activeNoteId);
  const { tags, refresh } = useTagBrowser();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    name: string;
    count: number;
  } | null>(null);
  const [softSelected, setSoftSelected] = useState<string | null>(null);
  const listId = useId();
  const { toast } = useToast();

  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    setSearchQuery("");
  }, [activeNoteId]);

  const sortedTags = [...tags].sort((a, b) => a.name.localeCompare(b.name));

  const filteredTags =
    searchQuery === ""
      ? sortedTags
      : sortedTags.filter((t) =>
          t.name.toLowerCase().includes(searchQuery.toLowerCase()),
        );

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

  return (
    <>
      <div style={panelCardStyle}>
        {/* Panel header — label (left) + × close button (right) */}
        <header style={headerStyle}>
          {/* Static label; panel visibility is gated by parent via panelSelector */}
          <span style={{ ...headerLabelStyle, flex: 1 }}>Tags ({tags.length})</span>
          <button
            type="button"
            aria-label="Close Tags panel"
            style={closeButtonStyle}
            onClick={() => {
              useTreeStore.getState().setPanelSelector({ tags: false });
            }}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </header>

        <>
          {/* Tag search input */}
            <div style={{ padding: "8px 12px", flexShrink: 0 }}>
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSearchQuery("");
                    (e.currentTarget as HTMLInputElement).focus();
                  }
                }}
                placeholder="Filter tags…"
                aria-label="Filter tag list"
                style={{
                  width: "100%",
                  height: 28,
                  padding: "0 8px",
                  fontSize: 14,
                  background: "var(--color-bg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 4,
                  color: "var(--color-fg)",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <ul id={listId} role="list" style={listStyle}>
              {/* Empty state: "no match" vs "no tags yet" */}
              {filteredTags.length === 0 ? (
                searchQuery !== "" ? (
                  <li>
                    <p role="status" style={emptyStateStyle}>
                      No tags match &ldquo;{searchQuery}&rdquo;.
                    </p>
                  </li>
                ) : (
                  <li>
                    <p role="status" style={emptyStateStyle}>
                      No tags yet. Type #tagname in any note to add a tag.
                    </p>
                  </li>
                )
              ) : (
                filteredTags.map((tag) => {
                  const isActive = activeTagFilter === tag.name;
                  const isRenaming = renaming === tag.name;

                  const isSoftSelected = softSelected === tag.name;

                  return (
                    <li key={tag.name} role="listitem">
                      {/* Clear soft-select when context menu closes */}
                      <ContextMenu.Root
                        onOpenChange={(open) => {
                          if (!open) setSoftSelected(null);
                        }}
                      >
                        <ContextMenu.Trigger asChild>
                          <button
                            type="button"
                            data-testid={`tag-row-${tag.name}`}
                            data-active={isActive ? "true" : "false"}
                            style={{
                              ...rowBaseStyle,
                              background:
                                isActive || isSoftSelected
                                  ? "color-mix(in srgb, var(--color-accent) 8%, transparent)"
                                  : undefined,
                            }}
                            onClick={() => {
                              if (!isRenaming) {
                                setActiveTagFilter(tag.name);
                              }
                            }}
                            onContextMenu={() => setSoftSelected(tag.name)}
                            onMouseEnter={(e) => {
                              if (!isActive && !isSoftSelected) {
                                (
                                  e.currentTarget as HTMLButtonElement
                                ).style.background =
                                  "color-mix(in srgb, var(--color-fg) 4%, transparent)";
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (!isActive && !isSoftSelected) {
                                (
                                  e.currentTarget as HTMLButtonElement
                                ).style.background = "transparent";
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
                                {/* #tagname in accent color; count as a pill badge */}
                                <span
                                  style={{
                                    ...(isActive
                                      ? tagNameActiveStyle
                                      : tagNameStyle),
                                    color: "var(--color-accent)",
                                  }}
                                >
                                  #{tag.name}
                                </span>
                                <span
                                  aria-label={`${tag.count} notes`}
                                  style={{
                                    marginLeft: 8,
                                    padding: "0 6px",
                                    height: 18,
                                    minWidth: 18,
                                    borderRadius: 9,
                                    background:
                                      "color-mix(in srgb, var(--color-fg) 10%, transparent)",
                                    color: "var(--color-muted)",
                                    fontSize: 11,
                                    fontWeight: 600,
                                    lineHeight: "18px",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    flexShrink: 0,
                                  }}
                                >
                                  {tag.count}
                                </span>
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
        </>
      </div>

      {/* Confirmation dialog — only shown when tag count > 5 */}
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
