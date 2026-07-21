/**
 * RightRailTagsPanel — body-only tag browser section in the right rail
 * (Phase 20 trim, D-08/D-09; mounted as the Tags tab's LOWER (vault-wide)
 * section by RightRail.tsx's Phase 30 two-section rework — see §2 of
 * 30-UI-SPEC.md. The upper (active-note) section is NoteTagsSection.tsx.
 *
 * Owns its own "Tags" + count sub-header (RightRailSubHeader, ported from
 * SectionHeader.tsx) since Phase 20's external SectionHeader no longer
 * supplies it in the tab-row model — no × close button, no substring filter
 * input. Body renders only the tag list, click-to-filter, and the
 * rename/delete ContextMenu flow. List uses `flex: 1` to fill the remaining
 * panel space (no fixed maxHeight).
 *
 * The legacy left-sidebar TagBrowserSection.tsx (superseded by this
 * component in Phase 20) was deleted in Phase 30 Plan 05 as confirmed
 * dead code.
 */
import { type CSSProperties, useState } from "react";

import * as ContextMenu from "@radix-ui/react-context-menu";

import { useTreeStore } from "../lib/useTreeStore";
import { useTagBrowser } from "../lib/useTagBrowser";
import { renameTag, deleteTag } from "../lib/tagsApi";
import { sortTagsByCountDesc } from "../lib/tagSort";
import { TagDeleteConfirmDialog } from "./TagDeleteConfirmDialog";
import { RenameInput } from "./RenameInput";
import { RightRailSubHeader } from "./RightRailTabRow";
import { useToast } from "./toast.utils";


/** Panel shell — flat inside the tabbed rail. The floating-card chrome
 * (border + radius) predates the Phase 30 rail rewrite; inside the flat rail
 * body it read as a double border with rounded inner corners. */
const panelCardStyle: CSSProperties = {
  background: "var(--color-surface)",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
};

/** Wraps the sub-header + card so this component fills whatever flex space
 * its RightRail.tsx parent gives it (height: "100%" would be wrong here
 * now that the sub-header is a sibling, not external). */
const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
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
  padding: "0 16px 0 24px",
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
  const { tags, refresh } = useTagBrowser();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    name: string;
    count: number;
  } | null>(null);
  const [softSelected, setSoftSelected] = useState<string | null>(null);
  const { toast } = useToast();

  const sortedTags = sortTagsByCountDesc(tags);

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
      <div style={rootStyle}>
        <RightRailSubHeader title="Tags" count={tags.length} />
        <div style={panelCardStyle}>
          <ul role="list" style={listStyle}>
            {/* Empty state: vault has zero tags (D-10, mock-literal copy) */}
            {sortedTags.length === 0 ? (
              <li>
                <p role="status" style={emptyStateStyle}>
                  No tags in this vault
                </p>
              </li>
            ) : (
            sortedTags.map((tag) => {
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
                                {/* plain fg text; only the active tag gets accent (UI-SPEC: vault list stays plain) */}
                                <span
                                  style={
                                    isActive ? tagNameActiveStyle : tagNameStyle
                                  }
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
        </div>
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
