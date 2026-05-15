/**
 * CommandMenu — shared modal shell for both the quick-switcher (mode="notes")
 * and command palette (mode="commands"). UI-SPEC §Surface 1.
 *
 * Uses @radix-ui/react-dialog (NOT AlertDialog — this is non-destructive per
 * UI-SPEC §Surface 1 note). Wire-up to global keymap happens in Plan 07-12
 * (App.tsx + KeyboardShortcutsDialog).
 *
 * Bucket B1 (Plan 07-18): notes mode now merges the quick-switcher and the
 * FTS5 backend search into a single interaction:
 *   - empty / < 2 chars: useQuickSwitcher (fuzzysort over in-memory titles)
 *   - >= 2 chars: useSearch debounced FTS5 backend search; results rendered
 *     using SearchResultRow (mark-highlighted excerpt + breadcrumb path).
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
import { useSearch } from "../lib/useSearch";
import { useTreeStore } from "../lib/useTreeStore";
import { KeyboardChip } from "./KeyboardChip";
import { SearchResultRow } from "./SearchResultRow";
import type { Shortcut } from "../lib/shortcutsRegistry";
import type { SearchResult } from "../lib/searchApi";

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

// Bucket B1 (Plan 07-18): FTS5 search result item kind.
interface SearchHitItem {
  kind: "search-result";
  id: string;
  result: SearchResult;
}

type Item = NoteItem | CmdItem | SearchHitItem;

export interface CommandMenuProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: "notes" | "commands";
  actions: CommandActions;
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

  // Bucket B1 (Plan 07-18): when palette is in notes mode AND user has typed
  // 2+ chars, fire the FTS5 backend search. Below threshold, the existing
  // useQuickSwitcher path runs (fuzzysort over note titles).
  const activeTagFilter = useTreeStore((s) => s.activeTagFilter);
  const { results: searchResults } = useSearch(
    mode === "notes" ? query : "",
    activeTagFilter,
  );
  const showSearchResults = mode === "notes" && query.length >= 2;

  // Unified item list for keyboard navigation and virtualization
  const items: Item[] =
    mode === "notes"
      ? showSearchResults
        ? searchResults.map((r) => ({
            kind: "search-result" as const,
            id: r.id,
            result: r,
          }))
        : noteHits.map((h) => ({
            kind: "note" as const,
            id: h.id,
            title: h.title,
            path: h.path,
          }))
      : cmdHits.map((c) => ({
          kind: "cmd" as const,
          id: c.id,
          label: c.label,
          shortcut: c.shortcut,
          group: c.group,
        }));

  // Reset selection when query or result list changes
  useEffect(() => {
    setSelectedIdx(0);
  }, [query, items.length]);

  // UAT-2 R1-3 (Plan 07-23 Fix B): reset query on open AND on mode change.
  //
  // Previously: `if (!open) setQuery("")` — fires only when open goes false,
  // so a mode flip while the palette stays open (Plan 07-17 closeOnExecute=false
  // for switch-note) left the previous query string in the input.
  //
  // Fix: `if (open) setQuery("")` with `[open, mode]` deps — clears on every
  // open transition AND on every mode flip while open. This means:
  //   1. open=false → open=true: clears (same as before)
  //   2. open=true, mode=commands → mode=notes: clears (new — UAT-2 R1-3)
  // Tradeoff: if the user typed a query and the parent re-renders with the
  // same open=true/mode=notes without changing either dep, the effect does
  // NOT re-run, so the user's query is preserved mid-session (correct).
  useEffect(() => {
    if (open) setQuery("");
  }, [open, mode]);

  // Virtualization
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => showSearchResults ? 88 : 36,
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

  // Bucket B1 (Plan 07-18): activate handles the new search-result kind.
  // Both "note" and "search-result" kinds open a note and close the palette.
  const activate = (i: number) => {
    const item = items[i];
    if (!item) return;
    if (item.kind === "note" || item.kind === "search-result") {
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(items.length - 1, i + 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(0, i - 1));
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
  // Per plan: "for v1 simplicity, omit them (or render only the group label of
  // the first row in each group)". The current implementation renders rows
  // without group separators — this is intentional v1 scope reduction.

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

                  // Bucket B1 (Plan 07-18): FTS5 search result rows use
                  // SearchResultRow for mark-highlighted excerpts + breadcrumbs.
                  // SearchResultRow's own onClick calls setActiveNote; the palette
                  // wrapper's onClick (below) is not needed for this kind.
                  if (item.kind === "search-result") {
                    return (
                      <div
                        key={item.id}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${vi.start}px)`,
                          background: selected
                            ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                            : "transparent",
                        }}
                        onMouseEnter={() => setSelectedIdx(vi.index)}
                        onClick={() => activate(vi.index)}
                      >
                        <SearchResultRow result={item.result} />
                      </div>
                    );
                  }

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
