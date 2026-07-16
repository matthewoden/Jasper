/**
 * CommandMenu — shared modal shell for four palette modes:
 *   - mode="all"      (Cmd+K)         — unified notes + commands, kind-badged
 *   - mode="notes"    (Cmd+O)         — title-fuzzy quick switcher only
 *   - mode="commands" (Cmd+P)         — command palette
 *   - mode="search"   (Cmd+Shift+F)  — FTS5 body search + snippet excerpts
 *
 * Global keymap wiring lives in App.tsx. All colors via var(--color-*) tokens.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search, Command, Loader2 } from "lucide-react";
import fuzzysort from "fuzzysort";
import { useQuickSwitcher } from "../lib/useQuickSwitcher";
import { useCommandPalette, type CommandActions } from "../lib/useCommandPalette";
import { useSearch } from "../lib/useSearch";
import { useTreeStore } from "../lib/useTreeStore";
import { useTabStore } from "../lib/useTabStore";
import { KeyboardChip } from "./KeyboardChip";
import { SearchResultRow } from "./SearchResultRow";
import type { Shortcut } from "../lib/shortcutsRegistry";
import type { SearchResult } from "../lib/searchApi";


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
  disabled?: boolean;
}


interface SearchHitItem {
  kind: "search-result";
  id: string;
  result: SearchResult;
}


interface GroupItem {
  kind: "group";
  id: string;
  label: string;
}

type Item = NoteItem | CmdItem | SearchHitItem | GroupItem;

export type PaletteMode = "notes" | "commands" | "search" | "all";

export interface CommandMenuProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: PaletteMode;
  actions: CommandActions;
}


// Kind badge — copied verbatim from the autocomplete detail-badge treatment
// (theme.css:300-319) per the UI-SPEC contract; the padding: "0 6px" inset is
// an owner-approved component-internal exception to the 4px grid (see
// 22-UI-SPEC.md "Spacing Scale" + memory pill-inset-grid-exception).
const kindBadgeBaseStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 16,
  height: 16,
  padding: "0 6px",
  borderRadius: 8,
  fontSize: 11,
  fontWeight: 600,
  lineHeight: "16px",
  flexShrink: 0,
};

const noteKindBadgeStyle: React.CSSProperties = {
  ...kindBadgeBaseStyle,
  background: "color-mix(in srgb, var(--color-fg) 10%, transparent)",
  color: "var(--color-muted)",
};

const cmdKindBadgeStyle: React.CSSProperties = {
  ...kindBadgeBaseStyle,
  background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
  color: "var(--color-accent)",
};

function nextSelectable(items: Item[], from: number, direction: 1 | -1): number {
  let i = from + direction;
  while (i >= 0 && i < items.length) {
    if (items[i].kind !== "group") return i;
    i += direction;
  }
  return from;
}


function ActivityIndicator() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        padding: "48px 16px",
        textAlign: "center",
        color: "var(--color-muted)",
        fontSize: 14,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
      }}
    >
      {/* Scoped keyframe — avoids global CSS changes. */}
      <style>
        {`@keyframes jasper-cmm-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}
      </style>
      <Loader2
        size={14}
        style={{
          animation: "jasper-cmm-spin 1s linear infinite",
          flexShrink: 0,
        }}
        aria-hidden="true"
      />
      <span>Searching…</span>
    </div>
  );
}


export function CommandMenu({ open, onOpenChange, mode, actions }: CommandMenuProps) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);

  const noteHits = useQuickSwitcher(mode === "notes" || mode === "all" ? query : "");

  const cmd = useCommandPalette(actions);
  const cmdHits: Shortcut[] = mode === "commands" || mode === "all" ? cmd.filtered(query) : [];

  const activeTagFilter = useTreeStore((s) => s.activeTagFilter);
  const { results: searchHits, isSearching } = useSearch(
    mode === "search" ? query : "",
    mode === "search" ? activeTagFilter : null,
  );

  let items: Item[];
  if (mode === "commands") {
    items = cmdHits.map((c) => ({
      kind: "cmd" as const,
      id: c.id,
      label: c.label,
      shortcut: c.shortcut,
      group: c.group,
      disabled: cmd.isDisabled?.(c.id) ?? false,
    }));
  } else if (mode === "search") {
    items = searchHits.map((r) => ({
      kind: "search-result" as const,
      id: r.id,
      result: r,
    }));
  } else if (mode === "all") {
    // Unified mode (D-01/D-03): notes + commands merged into one list, no
    // GroupItem header rows — the kind badge is the sole differentiator.
    // Empty query: notes (recents) first, then commands. Non-empty query:
    // single list ordered by match score across both kinds. Commands don't
    // carry a fuzzysort score of their own (cmd.filtered is substring-based),
    // so score them the same way useQuickSwitcher scores notes for a
    // comparable ranking key.
    const noteEntries = noteHits.map((h) => ({
      item: {
        kind: "note" as const,
        id: h.id,
        title: h.title,
        path: h.path,
      },
      score: h.score ?? 0,
    }));
    const cmdEntries = cmdHits.map((c) => {
      const scored = query ? fuzzysort.single(query, c.label) : null;
      return {
        item: {
          kind: "cmd" as const,
          id: c.id,
          label: c.label,
          shortcut: c.shortcut,
          group: c.group,
          disabled: cmd.isDisabled?.(c.id) ?? false,
        },
        score: scored?.score ?? -10000,
      };
    });
    if (!query) {
      items = [...noteEntries, ...cmdEntries].map((e) => e.item);
    } else {
      items = [...noteEntries, ...cmdEntries]
        .sort((a, b) => b.score - a.score)
        .map((e) => e.item);
    }
  } else {
    items = noteHits.map((h) => ({
      kind: "note" as const,
      id: h.id,
      title: h.title,
      path: h.path,
    }));
  }

  useEffect(() => {
    const first = items.findIndex((it) => it.kind !== "group");
    setSelectedIdx(first >= 0 ? first : 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, items.length]);

  useEffect(() => {
    if (open) setQuery("");
  }, [open, mode]);

  const [, setVirtualizerMountKey] = useState(0);
  useEffect(() => {
    if (open) {
      const id = setTimeout(() => {
        setVirtualizerMountKey((k) => k + 1);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [open]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const it = items[index];
      if (!it) return 36;
      if (it.kind === "group") return 24;
      if (it.kind === "search-result") return 88;
      return 36;
    },
    overscan: 5,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 0,
  });

  useEffect(() => {
    if (items.length > 0) {
      virtualizer.scrollToIndex(Math.max(0, Math.min(selectedIdx, items.length - 1)));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx]);

  useEffect(() => {
    virtualizer.measure();
  }, [mode, virtualizer]);

  const recordOpenedNote = useTreeStore((s) => s.recordOpenedNote);

  const activate = (i: number) => {
    const item = items[i];
    if (!item) return;
    if (item.kind === "group") return;
    if (item.kind === "note" || item.kind === "search-result") {
      useTabStore.getState().openTab(item.id);
      recordOpenedNote(item.id);
      onOpenChange(false);
      return;
    }
    if (item.kind === "cmd" && item.disabled) return;
    const shouldClose = cmd.execute(item.id);
    if (shouldClose) {
      onOpenChange(false);
    }
  };

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

  const Icon = mode === "commands" ? Command : Search;
  let placeholder: string;
  if (mode === "commands") {
    placeholder = "Type a command…";
  } else if (mode === "search") {
    placeholder = "Search notes…";
  } else if (mode === "all") {
    placeholder = "Search notes and commands…";
  } else {
    placeholder = "Switch to note…";
  }
  let ariaLabel: string;
  if (mode === "commands") {
    ariaLabel = "Command palette";
  } else if (mode === "search") {
    ariaLabel = "Search notes";
  } else if (mode === "all") {
    ariaLabel = "Search everything";
  } else {
    ariaLabel = "Quick switcher";
  }

  const showEmpty = items.length === 0;
  let emptyText: string | null = null;
  let searchSurfaceContent: React.ReactNode | null = null;
  if (mode === "search") {
    if (query === "") {
      searchSurfaceContent = (
        <div
          style={{
            padding: "48px 16px",
            textAlign: "center",
            color: "var(--color-muted)",
            fontSize: 14,
          }}
        >
          Type to search notes
        </div>
      );
    } else if (query.length < 2) {
      searchSurfaceContent = <ActivityIndicator />;
    } else if (isSearching && items.length === 0) {
      searchSurfaceContent = <ActivityIndicator />;
    } else if (items.length === 0) {
      searchSurfaceContent = (
        <div
          style={{
            padding: "48px 16px",
            textAlign: "center",
            color: "var(--color-muted)",
            fontSize: 14,
          }}
        >
          {`No notes match "${query}"`}
        </div>
      );
    }
    // else: results present → fall through to virtualized list below.
  } else if (showEmpty) {
    if (mode === "notes" && query === "") {
      emptyText = "Start typing to switch notes";
    } else if (mode === "notes" && query.length >= 2) {
      emptyText = `No notes match "${query}"`;
    } else if (mode === "notes" && query !== "") {
      emptyText = "Start typing to switch notes";
    } else if (mode === "commands" && query !== "") {
      emptyText = `No commands match "${query}"`;
    } else if (mode === "all" && query === "") {
      emptyText = "Start typing to search notes and commands";
    } else if (mode === "all" && query !== "") {
      emptyText = `No matching notes or commands for "${query}"`;
    }
    // commands mode + empty query → full list is shown; no empty state needed
  }


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
            width: 620,
            maxWidth: "calc(100vw - 48px)",
            background: "var(--color-border-inner)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            overflow: "hidden",
            animation: "jasper-cmm-popIn 140ms ease-out",
          }}
          onKeyDown={onKeyDown}
        >
          {/* Scoped popIn entrance — subtle scale+opacity, no layout jank. */}
          <style>
            {`@keyframes jasper-cmm-popIn { from { opacity: 0; transform: translateX(-50%) scale(0.98); } to { opacity: 1; transform: translateX(-50%) scale(1); } }`}
          </style>
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
            {/* Inline spinner on right edge of input row when mode=search +
                isSearching. Explicit mode guard prevents leaking the spinner
                into notes/commands modes. flexShrink:0 + fixed size keeps
                layout stable (no reflow on mount/unmount). */}
            {mode === "search" && isSearching && (
              <>
                <style>
                  {`@keyframes jasper-cmm-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}
                </style>
                <Loader2
                  size={14}
                  aria-label="Searching"
                  style={{
                    color: "var(--color-muted)",
                    flexShrink: 0,
                    animation: "jasper-cmm-spin 1s linear infinite",
                  }}
                />
              </>
            )}
            {/* Esc hint — right-aligned, present in every mode (D-04). */}
            <KeyboardChip>Esc</KeyboardChip>
          </div>

          {/* Result list — max-height 50vh */}
          <div ref={parentRef} style={{ maxHeight: "50vh", overflowY: "auto" }}>
            {/* search-mode surface (empty hint / activity indicator / no-matches)
                takes precedence over the generic emptyText path. */}
            {searchSurfaceContent !== null && searchSurfaceContent}

            {/* Empty state for notes + commands modes */}
            {searchSurfaceContent === null && emptyText !== null && (
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

            {/* Virtualized rows — suppressed when surfaceContent is active. */}
            {searchSurfaceContent === null && items.length > 0 && (
              <div
                style={{ height: virtualizer.getTotalSize(), position: "relative" }}
              >
                {virtualizer.getVirtualItems().map((vi) => {
                  const item = items[vi.index];
                  const selected = vi.index === selectedIdx;

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
                          cursor: "default",
                          userSelect: "none",
                        }}
                      >
                        {item.label}
                      </div>
                    );
                  }

                  if (item.kind === "search-result") {
                    return (
                      <div
                        key={item.id}
                        ref={virtualizer.measureElement}
                        data-index={vi.index}
                        data-row-kind="search-result"
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${vi.start}px)`,
                          background: selected
                            ? "color-mix(in srgb, var(--color-accent) 6%, transparent)"
                            : "transparent",
                        }}
                        onMouseEnter={() => setSelectedIdx(vi.index)}
                        onClick={() => activate(vi.index)}
                      >
                        <SearchResultRow result={item.result} />
                      </div>
                    );
                  }

                  const cmdDisabled = item.kind === "cmd" && item.disabled === true;
                  const rowStyle: React.CSSProperties = {
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                    height: vi.size,
                    padding: "0 16px",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 14,
                    color: cmdDisabled ? "var(--color-muted)" : "var(--color-fg)",
                    cursor: cmdDisabled ? "default" : "pointer",
                    background: selected
                      ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                      : "transparent",
                    userSelect: "none",
                    opacity: cmdDisabled ? 0.55 : 1,
                  };

                  return (
                    <div
                      key={item.id}
                      data-row-kind={item.kind}
                      data-disabled={cmdDisabled ? "true" : undefined}
                      aria-disabled={cmdDisabled || undefined}
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
                          <span style={noteKindBadgeStyle}>Note</span>
                        </>
                      ) : (
                        <>
                          <span style={{ flex: 1 }}>{item.label}</span>
                          {item.shortcut !== undefined && !cmdDisabled && (
                            <KeyboardChip>{item.shortcut}</KeyboardChip>
                          )}
                          <span style={cmdKindBadgeStyle}>Cmd</span>
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
