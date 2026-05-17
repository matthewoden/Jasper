/**
 * CommandMenu — shared modal shell for three distinct palette modes:
 *   - mode="notes"    (Cmd+O) — quick switcher, title-fuzzy only
 *   - mode="commands" (Cmd+P) — command palette
 *   - mode="search"   (Cmd+Shift+F) — FTS5 body search + snippet excerpts (Plan 07-40)
 *
 * Uses @radix-ui/react-dialog (NOT AlertDialog — this is non-destructive per
 * UI-SPEC §Surface 1 note). Wire-up to global keymap lives in App.tsx
 * (handleAppCmdP / handleAppCmdO / handleAppCmdShiftF).
 *
 * Plan 07-40 (UAT-6) — three-mode architecture supersedes Plan 07-39's
 * Sidebar-search wiring (D-58 in 07-CONTEXT.md). Search lives in this
 * modal as a third mode; the Sidebar no longer hosts any search UI.
 *
 * Plan 07-39 (UAT-5 N11) REVERTED Plan 07-33's title-fuzzy + FTS5 merge.
 * CommandMenu is title-fuzzy ONLY in notes mode (no commingled FTS5 hits).
 *
 * Group eyebrows in commands mode: deferred v1 (see comment below).
 * Implementation uses inline styles throughout — no hex literals; all colors
 * via var(--color-*) tokens.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search, Command, Loader2 } from "lucide-react";
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

// Plan 07-39 (UAT-5 N11): SearchHitItem REMOVED from the switcher's items.
// Plan 07-40 (UAT-6): SearchHitItem RE-ADDED as the row type used by
// mode='search' (CommandMenu's new third mode). The row itself reuses
// SearchResultRow from SearchResultRow.tsx (Plan 07-39 Task 2 legibility
// carries forward automatically).
interface SearchHitItem {
  kind: "search-result";
  id: string;
  result: SearchResult;
}

// Plan 07-33 holdover: group eyebrow separator. Plan 07-39 keeps the type
// because commands mode may still want it in a future iteration, but in
// notes mode we no longer emit groups (single-section list).
interface GroupItem {
  kind: "group";
  id: string;     // synthetic e.g. "group:notes" or "group:search"
  label: string;
}

type Item = NoteItem | CmdItem | SearchHitItem | GroupItem;

export interface CommandMenuProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  // Plan 07-40 (UAT-6): "search" is the third mode (Cmd+Shift+F).
  mode: "notes" | "commands" | "search";
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
// ActivityIndicator — Plan 07-43 (UAT-8)
//
// Inline Loader2 (spinning, via a scoped @keyframes spin) + 14px muted
// "Searching…" label. ~64px high (matches the 48px padding empty-state
// blocks above + below) so the modal doesn't reflow when the indicator
// appears/disappears across debounce + fetch boundaries.
// ──────────────────────────────────────────────────────────────────────────────

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
      {/* Scoped keyframe — kept inside the component so no global CSS
          changes are required. Tailwind/CSS-Modules-agnostic. */}
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

  // Plan 07-40 (UAT-6): search mode wraps useSearch (FTS5 + snippet excerpts).
  // Plan 07-43 (UAT-8): isSearching surfaces an inline activity indicator
  // below so users see in-window feedback. Plan 07-44 (UAT-8 follow-up):
  // debounce reverted to 200ms (was briefly 500ms in Plan 07-43) — the
  // activity indicator made the longer debounce unnecessary.
  // useSearch only fires above the 2-char threshold; pass empty string when
  // not in search mode so the hook is effectively dormant in notes/commands.
  const activeTagFilter = useTreeStore((s) => s.activeTagFilter);
  const { results: searchHits, isSearching } = useSearch(
    mode === "search" ? query : "",
    mode === "search" ? activeTagFilter : null,
  );

  // Plan 07-39 (UAT-5 N11): notes mode is title-fuzzy ONLY. Plan 07-40 adds
  // mode='search' which renders FTS5 SearchResultRow rows from useSearch.
  let items: Item[];
  if (mode === "commands") {
    items = cmdHits.map((c) => ({
      kind: "cmd" as const,
      id: c.id,
      label: c.label,
      shortcut: c.shortcut,
      group: c.group,
    }));
  } else if (mode === "search") {
    // mode === "search": single-section FTS5 results. Rows are SearchResultRow.
    items = searchHits.map((r) => ({
      kind: "search-result" as const,
      id: r.id,
      result: r,
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
    // commands mode only) and standard note/cmd row (36px). Plan 07-40 adds
    // SearchResultRow (~88px: title + path + 2-line excerpt + optional chips).
    //
    // Plan 07-42 (UAT-7): search-result rows actually vary 80-130px+ depending
    // on excerpt rendering (dangerouslySetInnerHTML reflows post-mount) and on
    // matching tag chips. The 88px estimate is now ONLY the initial guess;
    // `measureElement` below makes the virtualizer re-measure each rendered
    // row to its true offsetHeight, so tall rows no longer clip into the next.
    estimateSize: (index) => {
      const it = items[index];
      if (!it) return 36;
      if (it.kind === "group") return 24;
      if (it.kind === "search-result") return 88;
      return 36; // note and cmd rows
    },
    overscan: 5,
    // Plan 07-42 (UAT-7) — dynamic row measurement.
    // @tanstack/react-virtual passes each row's outer DOM element here; we
    // return its measured height so the virtualizer recalculates layout.
    //
    // Plan 07-44 (UAT-8 follow-up): measureElement is wired ONLY on the
    // search-result row branch via `ref={virtualizer.measureElement}` +
    // `data-index={vi.index}`. note / cmd / group rows do NOT attach the ref
    // and so the virtualizer keeps using the estimateSize values (36 / 24)
    // for those rows. This prevents non-search rows from being mismeasured
    // when their actual rendered DOM height exceeds the 36px estimate, and
    // it pairs with the mode-change `virtualizer.measure()` call below so
    // that cached search-result heights don't leak across modes.
    measureElement: (el) => el?.getBoundingClientRect().height ?? 0,
  });

  // Scroll selected item into view
  useEffect(() => {
    if (items.length > 0) {
      virtualizer.scrollToIndex(Math.max(0, Math.min(selectedIdx, items.length - 1)));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx]);

  // Plan 07-44 (UAT-8 follow-up) — reset cached row measurements on mode change.
  //
  // @tanstack/react-virtual caches per-index `measureElement` results. Plan
  // 07-42 wired measurement for search-result rows (which vary 80-130px+).
  // When the user opens search mode, sees results, then flips to commands
  // (Cmd+P) or notes (Cmd+O) mode, the virtualizer would otherwise apply
  // the cached search-result heights to whatever items now sit at the same
  // indices — making non-search rows render at the wrong positions.
  //
  // `virtualizer.measure()` is @tanstack/react-virtual's canonical
  // "forget all cached measurements" API. Mode changes are user-initiated
  // and rare (a few per session), so the cost is negligible.
  useEffect(() => {
    virtualizer.measure();
  }, [mode, virtualizer]);

  // Store actions
  const setActiveNote = useTreeStore((s) => s.setActiveNote);
  const recordOpenedNote = useTreeStore((s) => s.recordOpenedNote);

  // Plan 07-39 (UAT-5 N11): activate handles "note" + "cmd" + defensive
  // "group" no-op. Plan 07-40 (UAT-6) re-adds the "search-result" branch
  // for mode='search' — selecting a search hit opens the note (same as
  // a notes-mode selection).
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
    if (item.kind === "search-result") {
      // Mirror the notes-mode selection contract: set active note, record
      // recency, close modal.
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

  // UI metadata per mode. Plan 07-40 (UAT-6) — search mode gets its own
  // placeholder + aria label; the Search icon is shared with notes mode.
  const Icon = mode === "commands" ? Command : Search;
  let placeholder: string;
  if (mode === "commands") {
    placeholder = "Type a command…";
  } else if (mode === "search") {
    placeholder = "Search notes…";
  } else {
    placeholder = "Switch to note…";
  }
  let ariaLabel: string;
  if (mode === "commands") {
    ariaLabel = "Command palette";
  } else if (mode === "search") {
    ariaLabel = "Search notes";
  } else {
    ariaLabel = "Quick switcher";
  }

  // Determine empty state copy.
  // Notes:    empty/short query → "Start typing…"; ≥2 chars no hits → "No notes match…"
  // Commands: only shows empty state when a query is set and yields no hits.
  // Search:   Plan 07-43 (UAT-8) branching — uses searchSurfaceContent below.
  //   - query === ""           → "Type to search notes" (one-liner; was the
  //                              old prescriptive "at least 2 characters" copy)
  //   - 0 < query.length < 2   → activity indicator (typing-in-progress; the
  //                              system is responsive even though we won't
  //                              fetch yet)
  //   - query >= 2, isSearching → activity indicator (in-flight fetch)
  //   - query >= 2, !isSearching, results === [] → existing "No notes match…"
  //   - query >= 2, results.length > 0           → virtualized results
  const showEmpty = items.length === 0;
  let emptyText: string | null = null;
  // searchSurfaceContent is the React node rendered into the result area
  // when mode === "search" and we do NOT want to display the virtualized
  // result list (i.e. we're showing empty hint, activity indicator, or
  // a no-matches state). When null, the standard emptyText render path runs.
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
      // Sub-MIN typing feedback (debounce hasn't fired yet). The result-area
      // indicator is the right surface here because we have nothing to fall
      // back on: results.length is 0 by definition (query < 2 → useSearch
      // doesn't fire).
      searchSurfaceContent = <ActivityIndicator />;
    } else if (isSearching && items.length === 0) {
      // Plan 07-45 (UAT-8 follow-up 2): NARROWED from `isSearching` to
      // `isSearching && items.length === 0`. First-search fallback only —
      // when we have no prior results to show, the result-area indicator is
      // still the right surface (nothing to keep stale). When we DO have
      // prior results, fall through to the virtualized list below so the
      // user sees the stale-but-visible context while the new fetch
      // completes. The input-row Loader2 (see below) is the visual cue
      // that a refresh is in flight.
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
            {/* Plan 07-45 (UAT-8 follow-up 2): inline activity indicator on
                the right edge of the input row. Gated on
                mode === "search" && isSearching so that:
                  - notes / commands modes never see it (defensive — those
                    modes don't fire useSearch, so isSearching is false
                    there anyway, but the explicit mode guard keeps a future
                    refactor from leaking a spinner into the wrong surface);
                  - when isSearching flips to false, the spinner unmounts
                    reactively (no manual cleanup);
                  - flexShrink: 0 + fixed 14px size keeps the input flex
                    layout stable (no reflow on mount/unmount; T-45-02
                    mitigation).
                Reuses the same jasper-cmm-spin keyframe registered by
                ActivityIndicator (the keyframe is global once any
                ActivityIndicator instance has mounted; we also inline the
                animation here directly so the spinner spins even when the
                result-area indicator isn't on screen, e.g. the
                stale-results-during-refine case). */}
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
          </div>

          {/* Result list — max-height 50vh, virtualized */}
          <div ref={parentRef} style={{ maxHeight: "50vh", overflowY: "auto" }}>
            {/* Plan 07-43 (UAT-8): search-mode surface (empty hint /
                activity indicator / no-matches) takes precedence over the
                generic emptyText path when mode === "search". */}
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

            {/* Virtualized rows — suppressed in search mode when the
                surfaceContent path is active (indicator/empty hint). */}
            {searchSurfaceContent === null && items.length > 0 && (
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

                  // Plan 07-40 (UAT-6): search-result branch RE-ADDED for
                  // mode='search'. Wraps SearchResultRow (Plan 07-39 Task 2
                  // legibility recipe) inside a virtualized positioned div.
                  // We do NOT pipe through the standard rowStyle below because
                  // SearchResultRow owns its own padding + active-row styling.
                  //
                  // Plan 07-42 (UAT-7): the outer container now attaches
                  // `ref={virtualizer.measureElement}` + `data-index={vi.index}`
                  // so @tanstack/react-virtual can measure each row's true
                  // rendered height (varies 80-130px+ depending on excerpt +
                  // matching tag chips). The fixed `height: vi.size` is
                  // intentionally OMITTED — the row sizes to its content and
                  // the virtualizer reads back the actual height. The
                  // `transform: translateY(vi.start)` still places the row at
                  // the correct virtual-scroll offset.
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
                          // Light selection hint while keyboard-navigating;
                          // SearchResultRow's own hover/active styling layers
                          // on top via its inline rowBg.
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

                  // Plan 07-44 (UAT-8 follow-up): non-search rows use
                  // `height: vi.size` (the estimate function's return value)
                  // rather than a hardcoded 36. The estimate function is the
                  // single source of truth; note/cmd rows return 36 and group
                  // rows return 24. measureElement is NOT attached on these
                  // branches (only search-result), so vi.size stays at the
                  // estimate for the lifetime of the row.
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
