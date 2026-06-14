/**
 * SearchResultRow — title → path breadcrumb → 2-line clamped excerpt with
 * <mark> highlighting → matching tag chips.
 *
 * Excerpt is rendered via sanitizeHtml with <mark> allowed through — marks
 * pop via brightness + weight contrast (muted base, fg+600 on match) rather
 * than a fill, so they read as emphasis rather than a form control.
 */
import { useState } from "react";
import { sanitizeHtml } from "../lib/sanitize";
import { useTreeStore } from "../lib/useTreeStore";
import type { SearchResult } from "../lib/searchApi";

interface SearchResultRowProps {
  result: SearchResult;
}

/** Format a slash-separated path as "a / b / c", stripping the trailing .md. */
function formatPath(path: string): string {
  const parts = path.split("/");
  if (parts.length > 0) {
    parts[parts.length - 1] = parts[parts.length - 1].replace(/\.md$/, "");
  }
  return parts.join(" / ");
}

export function SearchResultRow({ result }: SearchResultRowProps) {
  const activeNoteId = useTreeStore((s) => s.activeNoteId);
  const setActiveNote = useTreeStore((s) => s.setActiveNote);
  const setSearchActive = useTreeStore((s) => s.setSearchActive);
  const setSearchQuery = useTreeStore((s) => s.setSearchQuery);
  const setSearchResults = useTreeStore((s) => s.setSearchResults);
  const [hovered, setHovered] = useState(false);

  const isActive = activeNoteId === result.id;

  const handleClick = () => {
    setActiveNote(result.id);
    setSearchActive(false);
    setSearchQuery("");
    setSearchResults([]);
  };

  let rowBg = "transparent";
  if (isActive) {
    rowBg = "color-mix(in srgb, var(--color-accent) 12%, transparent)";
  } else if (hovered) {
    rowBg = "color-mix(in srgb, var(--color-muted) 8%, transparent)";
  }

  return (
    <>
      {/* Scoped style: muted base excerpt; bright+bold on <mark>-wrapped matches */}
      <style>{`
        .search-result-excerpt {
          color: var(--color-muted);
        }
        .search-result-excerpt mark {
          color: var(--color-fg);
          font-weight: 600;
          background: transparent;
          padding: 0;
        }
      `}</style>
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") handleClick();
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          padding: "12px 16px",
          cursor: "pointer",
          borderBottom:
            "1px solid color-mix(in srgb, var(--color-border) 50%, transparent)",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          background: rowBg,
          boxSizing: "border-box",
        }}
        aria-label={`Open note: ${result.title}`}
      >
        {/* Title */}
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--color-fg)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {result.title}
        </div>

        {/* Path breadcrumb */}
        <div
          style={{
            fontSize: 12,
            fontWeight: 400,
            color: "var(--color-muted)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {formatPath(result.path)}
        </div>

        {/* 2-line clamped excerpt — color driven by scoped .search-result-excerpt rule so CSS wins over inline */}
        {result.excerpt_html && (
          <div
            className="search-result-excerpt"
            style={{
              fontSize: 14,
              fontWeight: 400,
              lineHeight: 1.5,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(result.excerpt_html) }}
          />
        )}

        {/* Matching tag chips */}
        {result.matching_tags && result.matching_tags.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            {result.matching_tags.map((tag) => (
              <span
                key={tag}
                style={{
                  color: "var(--color-accent)",
                  fontSize: 12,
                }}
              >
                #{tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
