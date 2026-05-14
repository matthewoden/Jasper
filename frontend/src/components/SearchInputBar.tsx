/**
 * SearchInputBar — Phase 7 Surface 2 sidebar search input.
 * UI-SPEC §Surface 2 — 32px height, Search icon, placeholder "Search notes…",
 * clear-X button when value non-empty, focus ring on :focus-within.
 *
 * Reads/writes searchQuery from useTreeStore. On Esc, clears query.
 */
import { useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";

export function SearchInputBar() {
  const searchQuery = useTreeStore((s) => s.searchQuery);
  const setSearchQuery = useTreeStore((s) => s.setSearchQuery);
  const setSearchActive = useTreeStore((s) => s.setSearchActive);
  const setSearchResults = useTreeStore((s) => s.setSearchResults);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };

  const handleClear = () => {
    setSearchQuery("");
    setSearchActive(false);
    setSearchResults([]);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handleClear();
    }
  };

  return (
    <div style={{ padding: "8px 16px", flexShrink: 0 }}>
      {/* Input wrapper: 32px height, focus ring via inline state */}
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "var(--color-bg)",
          border: focused
            ? "1px solid var(--color-accent)"
            : "1px solid var(--color-border)",
          borderRadius: 6,
          height: 32,
          padding: "0 8px",
          boxSizing: "border-box",
          boxShadow: focused
            ? "0 0 0 2px color-mix(in srgb, var(--color-accent) 20%, transparent)"
            : "none",
          transition: "border-color 0.1s, box-shadow 0.1s",
        }}
      >
        {/* Left search icon */}
        <Search
          size={14}
          style={{ color: "var(--color-muted)", flexShrink: 0 }}
          aria-hidden="true"
        />
        {/* Text input */}
        <input
          ref={inputRef}
          type="text"
          value={searchQuery}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Search notes…"
          aria-label="Search notes"
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--color-fg)",
            fontSize: 14,
            fontFamily: "inherit",
            minWidth: 0,
          }}
        />
        {/* Clear-X button — only when value non-empty */}
        {searchQuery.length > 0 && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={handleClear}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              color: "var(--color-muted)",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color =
                "var(--color-fg)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color =
                "var(--color-muted)";
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
