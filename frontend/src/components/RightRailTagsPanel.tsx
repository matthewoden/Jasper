/**
 * RightRailTagsPanel — Phase 6.5 UX-T-01, UX-T-05.
 *
 * Relocated from TagBrowserSection (left sidebar) into the right rail.
 * Wrapped in floating panel card shell with a tag-search input above the list.
 *
 * Differences from TagBrowserSection:
 *   1. Uses `rightRailTagsPanelExpanded` slice (not the Phase 6 legacy slice)
 *   2. Header: `Tags (N)` title-case (not `TAGS (N)` uppercase)
 *   3. Header has bottom border separating it from content
 *   4. Tag search input (D-19 / UX-T-05): case-insensitive substring filter
 *   5. Search query resets when activeNoteId changes (D-20)
 *   6. List uses `flex: 1` (not fixed maxHeight: 240) to fill panel card
 *   7. Empty state uses body-first copy (not frontmatter-centric copy)
 *   8. Wrapped in panel card: borderRadius 8px, 1px border, --color-surface bg
 *
 * Security (T-06.5-10): filter query bound via `value=` only — never rendered
 * via dangerouslySetInnerHTML. Tag names from server pass through D-22 charset
 * normalization. (T-06.5-11): search resets on note switch via useEffect.
 *
 * Phase 6 TAGS-06/07 behaviors (rename/delete via context menu) are
 * preserved verbatim from TagBrowserSection — the relocated panel is a
 * superset of the original.
 *
 * NOTE: TagBrowserSection.tsx is left in the repo as dead code (ADD-only
 * invariant per CONTEXT D-32). This file is the active implementation.
 */
import { useState, useEffect, useId, type CSSProperties } from "react";
import { ChevronRight, ChevronDown, X } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";

import { useTreeStore } from "../lib/useTreeStore";
import { useTagBrowser } from "../lib/useTagBrowser";
import { renameTag, deleteTag } from "../lib/tagsApi";
import { TagDeleteConfirmDialog } from "./TagDeleteConfirmDialog";
import { RenameInput } from "./RenameInput";
import { useToast } from "./Toast";

// ────────────────────────────────────────────────────────────────────────────
// Locked styles (UI-SPEC §Surface 2-NEW)
// ────────────────────────────────────────────────────────────────────────────

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

/** Expand/collapse toggle button (left portion of header) */
const expandButtonStyle: CSSProperties = {
  flex: 1,
  height: 32,
  padding: 0,
  background: "none",
  border: "none",
  display: "flex",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
  textAlign: "left",
  outline: "none",
  userSelect: "none",
  minWidth: 0,
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

/** Tag list: flex-1 fills panel card height instead of Phase 6's maxHeight:240 */
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

// Context menu styles (mirrors TreeRowMenu locked styles)
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

// T-06-08-01: client-side pre-validation for tag names before PUT
const TAG_CHARSET_REGEX = /^[a-z0-9_-]+$/;

export function RightRailTagsPanel() {
  // Phase 6.5 slice (not the Phase 6 legacy left-sidebar slice)
  const expanded = useTreeStore((s) => s.rightRailTagsPanelExpanded);
  const setExpanded = useTreeStore((s) => s.setRightRailTagsPanelExpanded);
  const activeTagFilter = useTreeStore((s) => s.activeTagFilter);
  const setActiveTagFilter = useTreeStore((s) => s.setActiveTagFilter);
  // T-06.5-11: reset searchQuery when note switches
  const activeNoteId = useTreeStore((s) => s.activeNoteId);
  const { tags, refresh } = useTagBrowser();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    name: string;
    count: number;
  } | null>(null);
  // D-22: soft-select state — set on right-click, cleared when context menu closes
  const [softSelected, setSoftSelected] = useState<string | null>(null);
  const listId = useId();
  const { toast } = useToast();

  // D-19: local search state — NOT persisted (D-20)
  const [searchQuery, setSearchQuery] = useState("");

  // T-06.5-11: clear searchQuery when note switches (D-20: clears on note switch)
  useEffect(() => {
    setSearchQuery("");
  }, [activeNoteId]);

  // Sort alphabetically (server already does this; defense-in-depth)
  const sortedTags = [...tags].sort((a, b) => a.name.localeCompare(b.name));

  // D-19: strict case-insensitive substring filter
  const filteredTags =
    searchQuery === ""
      ? sortedTags
      : sortedTags.filter((t) =>
          t.name.toLowerCase().includes(searchQuery.toLowerCase()),
        );

  const handleRenameCommit = async (oldName: string, newName: string) => {
    // T-06-08-01: pre-validate charset before sending to server
    if (!TAG_CHARSET_REGEX.test(newName)) {
      throw new Error(
        "Tag names may only contain lowercase letters, digits, hyphens, and underscores.",
      );
    }
    try {
      const result = await renameTag(oldName, newName);
      setRenaming(null);
      await refresh();
      // If the active filter was the old name, update it
      if (activeTagFilter === oldName) {
        setActiveTagFilter(newName);
      }
      // Toast for N > 5 affected (D-23 — silent for N ≤ 5)
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
      // Silent delete for N ≤ 5
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
      // Show confirmation dialog for N > 5
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
      // Toast for N > 5 (D-24)
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

  // UI-SPEC §Surface 2-NEW §Panel Header aria-label
  const ariaLabel = expanded
    ? `Tags panel, expanded. ${tags.length} tags. Click to collapse.`
    : `Tags panel, collapsed. ${tags.length} tags. Click to expand.`;

  return (
    <>
      <div style={panelCardStyle}>
        {/* Panel header — flex row: expand-toggle (left) + × close button (right) */}
        {/* D-19: no icon before the label; D-04: per-panel × close button */}
        <header style={headerStyle}>
          <button
            type="button"
            style={expandButtonStyle}
            aria-expanded={expanded}
            aria-controls={listId}
            aria-label={ariaLabel}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <ChevronDown size={14} color="var(--color-muted)" aria-hidden="true" />
            ) : (
              <ChevronRight size={14} color="var(--color-muted)" aria-hidden="true" />
            )}
            {/* UI-SPEC: title-case, 12px, weight 600, --color-muted */}
            <span style={headerLabelStyle}>Tags ({tags.length})</span>
          </button>
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

        {/* Tag search input + list (shown only when expanded) */}
        {expanded && (
          <>
            {/* D-19 tag search input — UI-SPEC §Tag Search Input */}
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
              {/* Empty states — two variants per UI-SPEC */}
              {filteredTags.length === 0 ? (
                searchQuery !== "" ? (
                  /* SR5: no-match state when search has query */
                  <li>
                    <p role="status" style={emptyStateStyle}>
                      No tags match &ldquo;{searchQuery}&rdquo;.
                    </p>
                  </li>
                ) : (
                  /* TB12: no tags at all — body-first messaging per D-04 */
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
                      {/* D-22: onOpenChange clears soft-select when context menu closes */}
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
                                {/* D-20/D-21: #tagname in accent. UAT 2026-05-12:
                                    count rendered as a pill badge (was inline "(N)"). */}
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
