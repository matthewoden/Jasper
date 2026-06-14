/**
 * SearchInputBar — 32px search input with Search icon, clear-X button when
 * non-empty, and focus ring. Reads/writes searchQuery from useTreeStore.
 */
import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useTreeStore } from "../lib/useTreeStore";

export function SearchInputBar() {
  const searchQuery = useTreeStore((s) => s.searchQuery);
  const setSearchQuery = useTreeStore((s) => s.setSearchQuery);
  const setSearchActive = useTreeStore((s) => s.setSearchActive);
  const setSearchResults = useTreeStore((s) => s.setSearchResults);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onFocusSearch = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("jasper:focus-search", onFocusSearch);
    return () => {
      window.removeEventListener("jasper:focus-search", onFocusSearch);
    };
  }, []);

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
      {/* Input wrapper with focus ring driven by inline state */}
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
        <Search
          size={14}
          style={{ color: "var(--color-muted)", flexShrink: 0 }}
          aria-hidden="true"
        />
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
        {/* Clear-X button — hidden when empty */}
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
