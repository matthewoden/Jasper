/**
 * SidebarSearchPanel — in-sidebar Search panel (LSIDE-02), mounted below the
 * shared 40px vault-name header when sidebarPanel === "search". Complements
 * the existing Cmd+P palette; does not replace it.
 *
 * Query/results live in useTreeStore's session-only searchQuery/searchResults
 * slice (D-18) so switching panels or unmounting/remounting this component
 * does not lose the in-progress search.
 *
 * Debounce mirrors useSearch.ts's cancelled-ref shape but writes to the store
 * instead of local state, and gates on the tokenized free-text length (a
 * tag-only query still searches once a tag: term is present).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";
import { usePaneStore } from "../lib/usePaneStore";
import { useWorkspace } from "../lib/useWorkspace";
import { subscribePhase7 } from "../lib/appShortcuts";
import { parseSearchQuery } from "../lib/searchQueryTokenizer";
import { searchNotes } from "../lib/searchApi";
import {
  filterSearchHistory,
  recordSearchHistory,
  removeHistoryEntry,
  useSearchHistory,
} from "../lib/searchHistory";
import { SidebarSearchResultRow } from "./SidebarSearchResultRow";
import { SearchSortDropdown } from "./SearchSortDropdown";
import { SearchHistoryHints } from "./SearchHistoryHints";

const DEBOUNCE_MS = 250;
const MIN_TEXT_LENGTH = 2;

export interface SidebarSearchPanelProps {
  onSelectNote?: (id: string) => void;
}

export function SidebarSearchPanel({ onSelectNote }: SidebarSearchPanelProps) {
  // Kept for prop-shape parity with FileTree's onSelectNote; rows activate via
  // usePaneStore.openInActivePane directly (D-17), so this callback is
  // currently unused.
  void onSelectNote;

  const searchQuery = useTreeStore((s) => s.searchQuery);
  const setSearchQuery = useTreeStore((s) => s.setSearchQuery);
  const searchResults = useTreeStore((s) => s.searchResults);
  const setSearchResults = useTreeStore((s) => s.setSearchResults);
  const { searchSort, setSearchSort } = useWorkspace();

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

  const [hintsOpen, setHintsOpen] = useState(false);
  const [activeHintIndex, setActiveHintIndex] = useState(-1);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const historyEntries = useSearchHistory();
  const hintMatches = useMemo(
    () => filterSearchHistory(historyEntries, searchQuery),
    [historyEntries, searchQuery],
  );

  const parsed = parseSearchQuery(searchQuery);
  const canSearch = parsed.tags.length > 0 || parsed.text.length >= MIN_TEXT_LENGTH;

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  useEffect(() => {
    const { tags, text } = parseSearchQuery(searchQuery);
    const shouldSearch = tags.length > 0 || text.length >= MIN_TEXT_LENGTH;
    if (!shouldSearch) {
      setSearchResults([]);
      setError(null);
      return;
    }
    const handle = setTimeout(() => {
      searchNotes(text, tags.length ? tags : undefined, 50, searchSort)
        .then((r) => {
          if (cancelled.current) return;
          setSearchResults(r);
          setError(null);
        })
        .catch(() => {
          if (cancelled.current) return;
          setError("Couldn't search notes. Try again.");
          setSearchResults([]);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchSort]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [searchResults]);

  // D-19: reset the keyboard-highlighted hint whenever the match set changes
  // (query typed, history mutated) — mirrors the selectedIdx/searchResults effect above.
  useEffect(() => {
    setActiveHintIndex(0);
  }, [hintMatches]);

  useEffect(
    () =>
      subscribePhase7((ev) => {
        if (ev === "focusSearch") {
          inputRef.current?.focus();
          inputRef.current?.select();
        }
      }),
    [],
  );

  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current !== undefined) clearTimeout(blurTimeoutRef.current);
    };
  }, []);

  const onSelectHint = (hint: string) => {
    setSearchQuery(hint);
    recordSearchHistory(hint);
    setHintsOpen(false);
    setActiveHintIndex(-1);
    inputRef.current?.focus();
  };

  const onRemoveHint = (hint: string) => {
    removeHistoryEntry(hint);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const hintsActive = hintsOpen && hintMatches.length > 0;

    // D-20: hints-priority branch — while hints are open with matches, arrows/Enter
    // act on the hints list and results keyboard nav is suspended.
    if (hintsActive) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveHintIndex((i) => Math.min(i + 1, hintMatches.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveHintIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const idx = activeHintIndex >= 0 ? activeHintIndex : 0;
        const hint = hintMatches[idx];
        if (hint) onSelectHint(hint);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Dismiss hints ONLY this keystroke — arrows return to results on the
        // NEXT Esc/interaction, matching the existing Esc double-behavior below.
        setHintsOpen(false);
        setActiveHintIndex(-1);
        return;
      }
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) =>
        searchResults.length === 0 ? 0 : Math.min(i + 1, searchResults.length - 1),
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const result = searchResults[selectedIdx];
      if (result) {
        recordSearchHistory(searchQuery);
        // Close hints at the commit point: the just-recorded query
        // prefix-matches itself, so leaving hintsOpen true would reopen the
        // dropdown over the results and hijack arrow-key nav (WR-02).
        setHintsOpen(false);
        setActiveHintIndex(-1);
        usePaneStore.getState().openInActivePane(result.id);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (searchQuery !== "") {
        setSearchQuery("");
        setSearchResults([]);
      } else {
        inputRef.current?.blur();
      }
    }
  };

  let statusContent: React.ReactNode;
  if (error) {
    statusContent = error;
  } else if (!canSearch) {
    statusContent = null;
  } else if (searchResults.length === 0) {
    statusContent = `No matches for "${searchQuery}"`;
  } else {
    statusContent = searchResults.length === 1 ? "1 result" : `${searchResults.length} results`;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        style={{
          padding: "8px 16px",
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            gap: 8,
            border: "1px solid var(--color-border-input)",
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          <Search size={14} aria-hidden="true" style={{ color: "var(--color-muted)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => {
              if (blurTimeoutRef.current !== undefined) {
                clearTimeout(blurTimeoutRef.current);
                blurTimeoutRef.current = undefined;
              }
              setHintsOpen(true);
            }}
            onBlur={() => {
              // Defer close so a click on a hint row registers first (its
              // click handler fires before this macrotask runs).
              blurTimeoutRef.current = setTimeout(() => setHintsOpen(false), 0);
            }}
            placeholder="Search notes… (tag:name to filter)"
            aria-label="Search notes"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--color-fg)",
              fontSize: 14,
              minWidth: 0,
            }}
          />
          <SearchSortDropdown value={searchSort} onSelect={setSearchSort} />
          {hintsOpen && (
            <SearchHistoryHints
              query={searchQuery}
              activeIndex={activeHintIndex}
              onSelectHint={onSelectHint}
              onRemoveHint={onRemoveHint}
            />
          )}
        </div>
      </div>

      {statusContent !== null && (
        <div
          role={error ? "alert" : undefined}
          style={{
            padding: "8px 16px",
            fontSize: 12,
            color: error ? "var(--color-destructive)" : "var(--color-muted)",
            flexShrink: 0,
          }}
        >
          {statusContent}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {!canSearch && (
          <div
            style={{
              padding: "48px 16px 0",
              textAlign: "center",
              fontSize: 14,
              color: "var(--color-muted)",
            }}
          >
            Search your notes
          </div>
        )}

        {canSearch &&
          searchResults.map((result, idx) => (
            <SidebarSearchResultRow key={result.id} result={result} isSelected={idx === selectedIdx} />
          ))}
      </div>
    </div>
  );
}
