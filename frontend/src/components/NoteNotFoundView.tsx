/**
 * NoteNotFoundView — Phase 8 Plan 08-07 / D-32 / UI-SPEC §Surface 6.
 *
 * Rendered at the `/note-not-found` route when the boot-time
 * useDeepLink hook fails to resolve a `?note=<uuid>` or `?path=<rel>`
 * deep link.
 *
 * Layout (LOCKED per UI-SPEC §Surface 6):
 *   - 480px centered card, 32px above viewport vertical center
 *   - Search icon (lucide-react, 32px, muted) — top, centered
 *   - Heading "This note doesn't exist"
 *   - Subtitle (echoes the failed query when present)
 *   - Search input pre-filled with the query
 *   - Primary CTA "Search notes"
 *   - Secondary row: "Open today's note" + "Show file tree"
 *   - Footer tip about ?note=<id> rename-resilience
 *
 * Copy strings are VERBATIM from UI-SPEC §Copywriting lines 222-231
 * (LOCKED). Any change to user-facing text is a UI-SPEC change.
 *
 * Search-modal mechanism: clicking "Search notes" navigates to
 * `/?search=<query>` — the main App boots, reads the param, and
 * opens the palette in search mode. The URL-param hand-off survives
 * the page reload that route changes incur on this SPA (we are NOT
 * inside the React tree of App when this view is mounted), unlike
 * a CustomEvent fired pre-navigation. Documented in the SUMMARY.
 *
 * Security (T-08-28): the subtitle interpolates `queryRaw` as a
 * React child — React escapes children automatically; we do NOT
 * use dangerouslySetInnerHTML. The `&lt;id&gt;` in the footer tip
 * is a hard-coded literal, NOT user input.
 */

import { Search } from "lucide-react";
import { useState } from "react";

import { useDailyNote } from "../lib/useDailyNote";

export function NoteNotFoundView() {
  const url = new URL(window.location.href);
  const queryRaw = url.searchParams.get("query") ?? "";
  const [searchInput, setSearchInput] = useState(queryRaw);
  const { openToday } = useDailyNote();

  const handleSearch = (): void => {
    const target = searchInput.trim();
    if (target) {
      window.location.assign(`/?search=${encodeURIComponent(target)}`);
    } else {
      window.location.assign("/?search=");
    }
  };

  const handleToday = async (): Promise<void> => {
    try {
      await openToday();
    } finally {
      window.location.assign("/");
    }
  };

  const handleTree = (): void => {
    window.location.assign("/");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSearch();
    }
  };

  const subtitle = queryRaw
    ? `Jasper couldn't find a note matching "${queryRaw}". It may have been moved, renamed, or never existed.`
    : `Jasper couldn't find that note. It may have been moved, renamed, or never existed.`;

  return (
    <div
      style={{
        background: "var(--color-bg)",
        color: "var(--color-fg)",
        minHeight: "100vh",
        padding: "32px",
      }}
      data-testid="note-not-found-view"
    >
      <div
        style={{
          maxWidth: 480,
          margin: "calc(50vh - 240px) auto 0",
          padding: 24,
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginBottom: 24,
          }}
        >
          <Search size={32} color="var(--color-muted)" strokeWidth={2} />
        </div>
        <h1
          style={{
            fontSize: 16,
            fontWeight: 600,
            lineHeight: 1.4,
            margin: 0,
            textAlign: "center",
          }}
        >
          This note doesn&apos;t exist
        </h1>
        <p
          style={{
            fontSize: 14,
            color: "var(--color-muted)",
            margin: "8px 0 0",
            lineHeight: 1.5,
            textAlign: "center",
          }}
        >
          {subtitle}
        </p>

        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search notes…"
          aria-label="Search notes"
          style={{
            width: "100%",
            height: 44,
            marginTop: 16,
            padding: "0 12px",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            background: "transparent",
            color: "var(--color-fg)",
            fontSize: 14,
            boxSizing: "border-box",
          }}
        />

        <button
          type="button"
          onClick={handleSearch}
          style={{
            width: "100%",
            height: 44,
            marginTop: 16,
            background: "var(--color-accent)",
            color: "var(--color-bg)",
            fontWeight: 600,
            fontSize: 14,
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Search notes
        </button>

        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button
            type="button"
            onClick={() => void handleToday()}
            style={{
              flex: 1,
              height: 36,
              background: "transparent",
              color: "var(--color-fg)",
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Open today&apos;s note
          </button>
          <button
            type="button"
            onClick={handleTree}
            style={{
              flex: 1,
              height: 36,
              background: "transparent",
              color: "var(--color-fg)",
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Show file tree
          </button>
        </div>

        <p
          style={{
            fontSize: 12,
            color: "var(--color-muted)",
            margin: "16px 0 0",
            textAlign: "center",
          }}
        >
          Tip: deep links use ?note=&lt;id&gt; for renames-resilient links.
        </p>
      </div>
    </div>
  );
}
