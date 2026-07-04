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
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";
import { useTabStore } from "../lib/useTabStore";
import { subscribePhase7 } from "../lib/appShortcuts";
import { parseSearchQuery } from "../lib/searchQueryTokenizer";
import { searchNotes } from "../lib/searchApi";
import { SidebarSearchResultRow } from "./SidebarSearchResultRow";

const DEBOUNCE_MS = 250;
const MIN_TEXT_LENGTH = 2;

export interface SidebarSearchPanelProps {
  onSelectNote?: (id: string) => void;
}

export function SidebarSearchPanel({ onSelectNote }: SidebarSearchPanelProps) {
  // Kept for prop-shape parity with FileTree's onSelectNote; rows activate via
  // useTabStore.openTab directly (D-17), so this callback is currently unused.
  void onSelectNote;

  const searchQuery = useTreeStore((s) => s.searchQuery);
  const setSearchQuery = useTreeStore((s) => s.setSearchQuery);
  const searchResults = useTreeStore((s) => s.searchResults);
  const setSearchResults = useTreeStore((s) => s.setSearchResults);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

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
      searchNotes(text, tags.length ? tags : undefined, 50)
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
  }, [searchQuery]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [searchResults]);

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

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
      if (result) useTabStore.getState().openTab(result.id);
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
