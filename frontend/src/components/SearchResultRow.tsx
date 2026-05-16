/**
 * SearchResultRow — Phase 7 Surface 3 row anatomy.
 * UI-SPEC §Surface 3: title (14/600) → path breadcrumb (12/muted) →
 * 2-line clamped excerpt with <mark> highlighting → matching tag chips.
 *
 * Excerpt uses sanitizeHtml (Phase 5 D-36) — <mark> survives per Task 1
 * locked SEARCH-04 contract (ADD_TAGS: ["mark"] in sanitize.ts).
 *
 * Plan 07-39 (UAT-5 N11) legibility update: the scoped <style> block now
 * mutes the base excerpt text (var(--color-muted)) and brightens the
 * <mark>-wrapped match (var(--color-fg) + font-weight 600 + transparent
 * background). Matched terms pop via brightness + weight contrast, not
 * a yellow box fill — the previous color-mix accent fill made the
 * highlight feel like a checkbox / form field rather than emphasis.
 */
import { useState } from "react";
import { sanitizeHtml } from "../lib/sanitize";
import { useTreeStore } from "../lib/useTreeStore";
import type { SearchResult } from "../lib/searchApi";

interface SearchResultRowProps {
  result: SearchResult;
}

/**
 * Render a path breadcrumb from a flat slash-separated path.
 * "notes/inbox/2026-05/note.md" → "notes / inbox / 2026-05 / note.md"
 * We drop the trailing .md from the display for clarity.
 */
function formatPath(path: string): string {
  const parts = path.split("/");
  // Remove .md extension from the last part for display
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

  // Determine row background per UI-SPEC §Surface 3.
  let rowBg = "transparent";
  if (isActive) {
    rowBg = "color-mix(in srgb, var(--color-accent) 12%, transparent)";
  } else if (hovered) {
    rowBg = "color-mix(in srgb, var(--color-muted) 8%, transparent)";
  }

  return (
    <>
      {/* Plan 07-39 (UAT-5 N11) legibility recipe.
          Base excerpt text is muted; <mark>-wrapped match is brightened to
          color-fg + 600 weight + transparent background. Matched terms pop
          via brightness + weight contrast, not a yellow box.
          Matches the backlinks-excerpt .backlink-ref recipe pattern. */}
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
        {/* Line 1: title (14px / 600) */}
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

        {/* Line 2: path breadcrumb (12px / muted) */}
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

        {/* Line 3: 2-line clamped excerpt with <mark> highlighting.
            Plan 07-39 (UAT-5 N11): color is now driven by the scoped
            .search-result-excerpt rule above (var(--color-muted)). The
            inline color is removed so the CSS rule wins. */}
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
            // T-7-23: server-built HTML MUST go through sanitize.ts (Phase 5 D-36 / SEARCH-04).
            // <mark> survives because sanitize.ts SAFE_CONFIG has ADD_TAGS: ["mark"] (Task 1).
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(result.excerpt_html) }}
          />
        )}

        {/* Line 4: matching tag chips — #tagname in accent, no fill */}
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
