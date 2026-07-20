/**
 * CommandMenu — shared modal shell for three palette modes:
 *   - mode="notes"    (Cmd+O)         — title-fuzzy quick switcher only
 *   - mode="commands" (Cmd+P)         — command palette
 *   - mode="search"   (Cmd+Shift+F)  — FTS5 body search + snippet excerpts
 *
 * Global keymap wiring lives in App.tsx. All colors via var(--color-*) tokens.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search, Command, Loader2, Plus } from "lucide-react";
import { useQuickSwitcher } from "../lib/useQuickSwitcher";
import { useCommandPalette, type CommandActions } from "../lib/useCommandPalette";
import { useSearch } from "../lib/useSearch";
import { useTreeStore } from "../lib/useTreeStore";
import { usePaneStore } from "../lib/usePaneStore";
import { useFileTree } from "../lib/useFileTree";
import { useResolvedTitleSet, resolveWikilinkTitle } from "../editor/wikilinkResolver";
import { KeyboardChip } from "./KeyboardChip";
import { SearchResultRow } from "./SearchResultRow";
import { getNoteFolder, parentDir } from "../lib/treeNoteLookup";
import { mod, shift, type Shortcut } from "../lib/shortcutsRegistry";
import type { SearchResult } from "../lib/searchApi";


interface NoteItem {
  kind: "note";
  id: string;
  title: string;
  path: string;
  /** 0-based char positions in `title` matched by the fuzzy query (D-15); undefined for the empty-query recency list. */
  matchIndexes?: readonly number[];
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

/** D-08 synthetic row — action, not a note. Always the last item when eligible. */
interface CreateItem {
  kind: "create";
  id: "create";
}

type Item = NoteItem | CmdItem | SearchHitItem | GroupItem | CreateItem;

export type PaletteMode = "notes" | "commands" | "search";

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

const cmdKindBadgeStyle: React.CSSProperties = {
  ...kindBadgeBaseStyle,
  background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
  color: "var(--color-accent)",
};

// D-14: notes-mode rows are two-line 56px, no kind badge (unlike commands mode).
const noteRowTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--color-fg)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const noteRowSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 400,
  color: "var(--color-muted)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

// D-08: create row uses var(--color-success) for the title (not --color-fg)
// as the distinguishing "this is an action, not a note" signal.
const createRowTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--color-success)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const createRowSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 400,
  color: "var(--color-muted)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/**
 * D-15: builds contiguous matched/unmatched runs from fuzzysort's 0-based
 * `matchIndexes`, wrapping matched runs in an accent-colored span. Plain
 * string return for empty-query rows (no indexes to highlight).
 */
function renderHighlightedTitle(
  title: string,
  matchIndexes?: readonly number[],
): React.ReactNode {
  if (!matchIndexes || matchIndexes.length === 0) return title;
  const idxSet = new Set(matchIndexes);
  const parts: React.ReactNode[] = [];
  let buffer = "";
  let bufferMatched = false;
  for (let i = 0; i < title.length; i++) {
    const matched = idxSet.has(i);
    if (matched !== bufferMatched && buffer) {
      parts.push(
        bufferMatched ? (
          <span key={parts.length} style={{ color: "var(--color-accent)" }}>
            {buffer}
          </span>
        ) : (
          buffer
        ),
      );
      buffer = "";
    }
    buffer += title[i];
    bufferMatched = matched;
  }
  if (buffer) {
    parts.push(
      bufferMatched ? (
        <span key={parts.length} style={{ color: "var(--color-accent)" }}>
          {buffer}
        </span>
      ) : (
        buffer
      ),
    );
  }
  return parts;
}

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

  const noteHits = useQuickSwitcher(mode === "notes" ? query : "");

  const cmd = useCommandPalette(actions);
  const cmdHits: Shortcut[] = mode === "commands" ? cmd.filtered(query) : [];

  const activeTagFilter = useTreeStore((s) => s.activeTagFilter);
  const { results: searchHits, isSearching } = useSearch(
    mode === "search" ? query : "",
    mode === "search" ? activeTagFilter : null,
  );

  // D-06/D-07/D-08 create-row support (notes mode only) — REUSE only, no new
  // title-matching or tree-walk logic lives in this component.
  const { tree } = useFileTree();
  const activeNoteId = useTreeStore((s) => s.activeNoteId);
  const { titleSet, idMap } = useResolvedTitleSet();
  const exactMatch =
    mode === "notes" && query !== ""
      ? resolveWikilinkTitle(query, titleSet, idMap)
      : { resolved: false, targetId: null };
  const activeFolder = getNoteFolder(activeNoteId, tree?.root ?? []);
  const folderLabel =
    activeFolder === "" ? "in vault root" : `in ${activeFolder.split("/").pop()}`;

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
  } else {
    items = noteHits.map((h) => ({
      kind: "note" as const,
      id: h.id,
      title: h.title,
      path: h.path,
      matchIndexes: h.matchIndexes,
    }));
    if (query !== "" && !exactMatch.resolved) {
      items = [...items, { kind: "create" as const, id: "create" as const }];
    }
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
      if (it.kind === "note" || it.kind === "create") return 56;
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

  // ARIA combobox/listbox wiring (notes mode only, per UI-SPEC Accessibility).
  const selectedItem = items[selectedIdx];
  const selectedOptionId =
    mode === "notes" &&
    selectedItem &&
    (selectedItem.kind === "note" || selectedItem.kind === "create")
      ? `qs-option-${selectedItem.id}`
      : undefined;

  const activate = (i: number) => {
    const item = items[i];
    if (!item) return;
    if (item.kind === "group") return;
    if (item.kind === "note" || item.kind === "search-result") {
      // Phase 25: opens as a tab in the active pane (WS-08's openInActivePane
      // primitive) — replaces the retired flat useTabStore.openTab.
      usePaneStore.getState().openInActivePane(item.id);
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
  } else {
    placeholder = "Find or create a note…";
  }
  let ariaLabel: string;
  if (mode === "commands") {
    ariaLabel = "Command palette";
  } else if (mode === "search") {
    ariaLabel = "Search notes";
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
              {...(mode === "notes"
                ? {
                    role: "combobox" as const,
                    "aria-expanded": items.length > 0,
                    "aria-controls": "quick-switcher-listbox",
                    "aria-activedescendant": selectedOptionId,
                  }
                : {})}
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
          <div
            ref={parentRef}
            id={mode === "notes" ? "quick-switcher-listbox" : undefined}
            role={mode === "notes" ? "listbox" : undefined}
            aria-label={mode === "notes" ? ariaLabel : undefined}
            style={{ maxHeight: "50vh", overflowY: "auto" }}
          >
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
                  const isNoteRow = item.kind === "note";
                  const isCreateRow = item.kind === "create";
                  const isNotesSelectableRow = isNoteRow || isCreateRow;
                  let rowStyle: React.CSSProperties;
                  if (isNoteRow) {
                    rowStyle = {
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      boxSizing: "border-box",
                      transform: `translateY(${vi.start}px)`,
                      height: vi.size,
                      padding: "8px 16px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      justifyContent: "center",
                      fontSize: 14,
                      color: "var(--color-fg)",
                      cursor: "pointer",
                      background: selected
                        ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                        : "transparent",
                      userSelect: "none",
                    };
                  } else if (isCreateRow) {
                    rowStyle = {
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      boxSizing: "border-box",
                      transform: `translateY(${vi.start}px)`,
                      height: vi.size,
                      padding: "8px 16px",
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      borderTop: "1px solid var(--color-border)",
                      fontSize: 14,
                      cursor: "pointer",
                      background: selected
                        ? "color-mix(in srgb, var(--color-success) 12%, transparent)"
                        : "transparent",
                      userSelect: "none",
                    };
                  } else {
                    rowStyle = {
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      boxSizing: "border-box",
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
                  }

                  return (
                    <div
                      key={item.id}
                      data-row-kind={item.kind}
                      data-disabled={cmdDisabled ? "true" : undefined}
                      aria-disabled={cmdDisabled || undefined}
                      role={isNotesSelectableRow ? "option" : undefined}
                      id={isNotesSelectableRow ? `qs-option-${item.id}` : undefined}
                      aria-selected={isNotesSelectableRow ? selected : undefined}
                      style={rowStyle}
                      onMouseEnter={() => setSelectedIdx(vi.index)}
                      onClick={() => activate(vi.index)}
                    >
                      {item.kind === "note" ? (
                        <>
                          <div style={noteRowTitleStyle}>
                            {renderHighlightedTitle(item.title, item.matchIndexes)}
                          </div>
                          <div style={noteRowSubtitleStyle}>
                            {parentDir(item.path) || "Vault"}
                          </div>
                        </>
                      ) : item.kind === "create" ? (
                        <>
                          <Plus
                            size={16}
                            style={{ color: "var(--color-success)", flexShrink: 0 }}
                            aria-hidden="true"
                          />
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: 4,
                              minWidth: 0,
                            }}
                          >
                            <div style={createRowTitleStyle}>{`Create "${query}"`}</div>
                            <div style={createRowSubtitleStyle}>{`New note · ${folderLabel}`}</div>
                          </div>
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

          {/* Footer legend (D-13) — always-on, notes mode only, sibling AFTER the scrollable list. */}
          {mode === "notes" && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 16,
                padding: "8px 16px",
                borderTop: "1px solid var(--color-border)",
                background: "var(--color-surface-raised)",
              }}
            >
              {[
                { glyph: "↵", label: "open" },
                { glyph: `${shift}↵`, label: "create" },
                { glyph: `${mod}${shift}↵`, label: "split" },
              ].map(({ glyph, label }) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <KeyboardChip>{glyph}</KeyboardChip>
                  <span style={{ fontSize: 12, color: "var(--color-muted)" }}>{label}</span>
                </div>
              ))}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
