/**
 * CommandMenu — shared modal shell for both the quick-switcher (mode="notes")
 * and command palette (mode="commands"). UI-SPEC §Surface 1.
 *
 * Uses @radix-ui/react-dialog (NOT AlertDialog — this is non-destructive per
 * UI-SPEC §Surface 1 note). Wire-up to global keymap happens in Plan 07-12
 * (App.tsx + KeyboardShortcutsDialog).
 *
 * Plan 07-39 (UAT-5 N11) REVERTED Plan 07-33's title-fuzzy + FTS5 merge.
 * CommandMenu is now title-fuzzy ONLY in notes mode. FTS5 search lives at
 * the Sidebar surface (SearchInputBar + SearchResultsList), not here. The
 * user wants two distinct mental models / surfaces:
 *   - Cmd+O (this component, notes mode): lightweight title-only switcher.
 *   - Sidebar Search: FTS5 body search with snippet excerpts (the original
 *     Plan 07-08 design, resurrected after Plan 07-18 orphaned its UI).
 *
 * Group eyebrows in commands mode: deferred v1 (see comment below).
 * Implementation uses inline styles throughout — no hex literals; all colors
 * via var(--color-*) tokens.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search, Command } from "lucide-react";
import { useQuickSwitcher } from "../lib/useQuickSwitcher";
import { useCommandPalette, type CommandActions } from "../lib/useCommandPalette";
import { useTreeStore } from "../lib/useTreeStore";
import { KeyboardChip } from "./KeyboardChip";
import type { Shortcut } from "../lib/shortcutsRegistry";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface NoteItem {
  kind: "note";
  id: string;
  title: string;
  path: string;
}

interface CmdItem {
  kind: "cmd";
  id: string;
  label: string;
  shortcut?: string;
  group: string;
}

// Plan 07-39 (UAT-5 N11): SearchHitItem REMOVED. The switcher no longer
// renders FTS5 hits — those live on the Sidebar (SearchResultsList).

// Plan 07-33 holdover: group eyebrow separator. Plan 07-39 keeps the type
// because commands mode may still want it in a future iteration, but in
// notes mode we no longer emit groups (single-section list).
interface GroupItem {
  kind: "group";
  id: string;     // synthetic e.g. "group:notes" or "group:search"
  label: string;
}

type Item = NoteItem | CmdItem | GroupItem;

export interface CommandMenuProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: "notes" | "commands";
  actions: CommandActions;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper: skip group-eyebrow rows during keyboard navigation
// ──────────────────────────────────────────────────────────────────────────────

function nextSelectable(items: Item[], from: number, direction: 1 | -1): number {
  let i = from + direction;
  while (i >= 0 && i < items.length) {
    if (items[i].kind !== "group") return i;
    i += direction;
  }
  return from; // clamp at original if no selectable in that direction
}

// ──────────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────────

export function CommandMenu({ open, onOpenChange, mode, actions }: CommandMenuProps) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Notes mode: fuzzysort over in-memory note list (always run; cheap pure client compute)
  const noteHits = useQuickSwitcher(mode === "notes" ? query : "");

  // Commands mode: label substring filter over COMMAND_PALETTE_ENTRIES
  const cmd = useCommandPalette(actions);
  const cmdHits: Shortcut[] = mode === "commands" ? cmd.filtered(query) : [];

  // Plan 07-39 (UAT-5 N11): notes mode is title-fuzzy ONLY. No FTS5 backend
  // call, no Search results section, no group eyebrows in notes mode. FTS5
  // search lives at the Sidebar surface (SearchInputBar + SearchResultsList).
  let items: Item[];
  if (mode === "commands") {
    items = cmdHits.map((c) => ({
      kind: "cmd" as const,
      id: c.id,
      label: c.label,
      shortcut: c.shortcut,
      group: c.group,
    }));
  } else {
    // mode === "notes": single-section title-fuzzy list. No eyebrows.
    items = noteHits.map((h) => ({
      kind: "note" as const,
      id: h.id,
      title: h.title,
      path: h.path,
    }));
  }

  // UAT-3 N10 + N11 (Plan 07-33): Start selectedIdx at the FIRST SELECTABLE row
  // (skip any leading group eyebrow). Previously `setSelectedIdx(0)` would land on
  // the group eyebrow when notes mode prepends "Switch to note" — fix: find the
  // first non-group index.
  useEffect(() => {
    const first = items.findIndex((it) => it.kind !== "group");
    setSelectedIdx(first >= 0 ? first : 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, items.length]);

  // UAT-2 R1-2 (Plan 07-23 Fix B): reset query on open AND on mode change.
  useEffect(() => {
    if (open) setQuery("");
  }, [open, mode]);

  // UAT-2 R1-2 (Plan 07-23): Force virtualizer to re-subscribe to ResizeObserver
  // after the dialog opens.
  const [, setVirtualizerMountKey] = useState(0); // mount key — only setter is used (triggers re-render)
  useEffect(() => {
    if (open) {
      const id = setTimeout(() => {
        setVirtualizerMountKey((k) => k + 1);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [open]);

  // Virtualization
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    // Plan 07-39 (UAT-5 N11): two possible row heights — group eyebrow (24px,
    // commands mode only) and standard note/cmd row (36px). FTS5 search-result
    // row removed (FTS5 lives at the Sidebar surface).
    estimateSize: (index) => {
      const it = items[index];
      if (!it) return 36;
      if (it.kind === "group") return 24;
      return 36; // note and cmd rows
    },
    overscan: 5,
  });

  // Scroll selected item into view
  useEffect(() => {
    if (items.length > 0) {
      virtualizer.scrollToIndex(Math.max(0, Math.min(selectedIdx, items.length - 1)));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx]);

  // Store actions
  const setActiveNote = useTreeStore((s) => s.setActiveNote);
  const recordOpenedNote = useTreeStore((s) => s.recordOpenedNote);

  // Plan 07-39 (UAT-5 N11): activate handles "note" + "cmd" + defensive
  // "group" no-op. The "search-result" branch was removed when FTS5 left
  // the switcher.
  const activate = (i: number) => {
    const item = items[i];
    if (!item) return;
    if (item.kind === "group") return; // defensive: groups are not activatable
    if (item.kind === "note") {
      setActiveNote(item.id);
      recordOpenedNote(item.id);
      onOpenChange(false);
      return;
    }
    // UAT #5 fix: respect per-command closeOnExecute. switch-note keeps the
    // palette open so the mode flip (commands → notes) re-renders the list.
    const shouldClose = cmd.execute(item.id);
    if (shouldClose) {
      onOpenChange(false);
    }
  };

  // UAT-3 N10 + N11 (Plan 07-33): keyboard navigation skips group-eyebrow rows
  // via nextSelectable() helper.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => nextSelectable(items, i, 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => nextSelectable(items, i, -1));
    }
    if (e.key === "Enter") {
      e.preventDefault();
      activate(selectedIdx);
    }
  };

  // UI metadata per mode
  const Icon = mode === "notes" ? Search : Command;
  const placeholder = mode === "notes" ? "Switch to note…" : "Type a command…";
  const ariaLabel = mode === "notes" ? "Quick switcher" : "Command palette";

  // Determine empty state copy (notes only; commands shows full list when empty query)
  const showEmpty = items.length === 0;
  let emptyText: string | null = null;
  if (showEmpty) {
    if (mode === "notes" && query === "") {
      emptyText = "Start typing to switch notes";
    } else if (mode === "notes" && query.length >= 2) {
      emptyText = `No notes match "${query}"`;
    } else if (mode === "notes" && query !== "") {
      emptyText = "Start typing to switch notes";
    } else if (mode === "commands" && query !== "") {
      emptyText = `No commands match "${query}"`;
    }
    // commands mode + empty query → full list is shown; no empty state needed
  }

  // NOTE: Group eyebrows in commands mode are deferred to v1 UAT feedback.

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.5)",
          }}
        />
        <Dialog.Content
          aria-label={ariaLabel}
          style={{
            position: "fixed",
            top: "12vh",
            left: "50%",
            transform: "translateX(-50%)",
            width: 600,
            maxWidth: "calc(100vw - 48px)",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            overflow: "hidden",
          }}
          onKeyDown={onKeyDown}
        >
          {/* Input row — 44px height, Search/Command icon, transparent input */}
          <div
            style={{
              height: 44,
              padding: "0 16px",
              borderBottom: "1px solid var(--color-border)",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <Icon
              size={16}
              style={{ color: "var(--color-muted)", flexShrink: 0 }}
            />
            <Dialog.Title style={{ display: "none" }}>{ariaLabel}</Dialog.Title>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              aria-label={ariaLabel}
              autoFocus
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: "var(--color-fg)",
                fontSize: 14,
                fontFamily: "inherit",
              }}
            />
          </div>

          {/* Result list — max-height 50vh, virtualized */}
          <div ref={parentRef} style={{ maxHeight: "50vh", overflowY: "auto" }}>
            {/* Empty state */}
            {emptyText !== null && (
              <div
                style={{
                  padding: "48px 16px",
                  textAlign: "center",
                  color: "var(--color-muted)",
                  fontSize: 14,
                }}
              >
                {emptyText}
              </div>
            )}

            {/* Virtualized rows */}
            {items.length > 0 && (
              <div
                style={{ height: virtualizer.getTotalSize(), position: "relative" }}
              >
                {virtualizer.getVirtualItems().map((vi) => {
                  const item = items[vi.index];
                  const selected = vi.index === selectedIdx;

                  // UAT-3 N10 + N11 (Plan 07-33): group eyebrow rows — non-selectable
                  // separators with subdued uppercase label.
                  if (item.kind === "group") {
                    return (
                      <div
                        key={vi.key}
                        data-row-kind="group"
                        data-group-id={item.id}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          right: 0,
                          transform: `translateY(${vi.start}px)`,
                          height: vi.size,
                          padding: "4px 16px 2px",
                          fontSize: 11,
                          fontWeight: 600,
                          textTransform: "uppercase",
                          color: "var(--color-muted)",
                          letterSpacing: "0.05em",
                          display: "flex",
                          alignItems: "center",
                          // Non-selectable: no hover, no click, no cursor pointer.
                          cursor: "default",
                          userSelect: "none",
                        }}
                      >
                        {item.label}
                      </div>
                    );
                  }

                  // Plan 07-39 (UAT-5 N11): search-result branch REMOVED.
                  // FTS5 hits live at the Sidebar surface (SearchResultsList).

                  const rowStyle: React.CSSProperties = {
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                    height: 36,
                    padding: "0 16px",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 14,
                    color: "var(--color-fg)",
                    cursor: "pointer",
                    background: selected
                      ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                      : "transparent",
                    userSelect: "none",
                  };

                  return (
                    <div
                      key={item.id}
                      data-row-kind={item.kind}
                      style={rowStyle}
                      onMouseEnter={() => setSelectedIdx(vi.index)}
                      onClick={() => activate(vi.index)}
                    >
                      {item.kind === "note" ? (
                        <>
                          <span
                            style={{
                              flex: 1,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {item.title}
                          </span>
                          <span
                            style={{
                              marginLeft: "auto",
                              color: "var(--color-muted)",
                              fontSize: 12,
                              flexShrink: 0,
                              maxWidth: "40%",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {item.path}
                          </span>
                        </>
                      ) : (
                        <>
                          <span style={{ flex: 1 }}>{item.label}</span>
                          {item.shortcut !== undefined && (
                            <KeyboardChip>{item.shortcut}</KeyboardChip>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
