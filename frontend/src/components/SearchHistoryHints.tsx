/**
 * SearchHistoryHints — focus-triggered, prefix-filtered recent-search
 * dropdown (HIST-01/02, D-19/D-20/D-21/D-22). Mounted inside
 * SidebarSearchPanel.tsx's search-input container (absolute-positioned
 * below the input), only while SidebarSearchPanel considers hints "open".
 *
 * Renders nothing (returns null) when history is empty or no entries
 * prefix-match the current query (D-19) — there is no "no recent
 * searches" placeholder row; the layer simply doesn't mount.
 *
 * Query text is rendered as plain JSX text content — React auto-escapes
 * it, so this is never a dangerouslySetInnerHTML surface (T-29-12 XSS).
 * Container styling matches TreeRowMenu.tsx's menuContainerStyle so this
 * reads as part of the existing menu family, not a bespoke popover.
 */
import { useState } from "react";
import { Clock, X } from "lucide-react";
import { filterSearchHistory, useSearchHistory } from "../lib/searchHistory";

export interface SearchHistoryHintsProps {
  query: string;
  /** Index of the keyboard-highlighted row, or -1 for none. */
  activeIndex: number;
  onSelectHint: (query: string) => void;
  onRemoveHint: (query: string) => void;
}

export function SearchHistoryHints({
  query,
  activeIndex,
  onSelectHint,
  onRemoveHint,
}: SearchHistoryHintsProps) {
  const history = useSearchHistory();
  const [hoveredRowIdx, setHoveredRowIdx] = useState<number | null>(null);
  const [hoveredXIdx, setHoveredXIdx] = useState<number | null>(null);

  const matches = filterSearchHistory(history, query);
  if (matches.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label="Recent searches"
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        right: 0,
        marginTop: 4,
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 6,
        paddingTop: 4,
        paddingBottom: 4,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        zIndex: 50,
        maxHeight: 360,
        overflowY: "auto",
      }}
    >
      {matches.map((entry, idx) => {
        const isActive = idx === activeIndex;
        const isRowHovered = idx === hoveredRowIdx;
        let rowBg = "transparent";
        if (isActive) {
          rowBg = "color-mix(in srgb, var(--color-accent) 12%, transparent)";
        } else if (isRowHovered) {
          rowBg = "color-mix(in srgb, var(--color-muted) 8%, transparent)";
        }

        return (
          <div
            key={entry}
            role="option"
            aria-selected={isActive}
            onMouseEnter={() => setHoveredRowIdx(idx)}
            onMouseLeave={() => setHoveredRowIdx((cur) => (cur === idx ? null : cur))}
            onClick={() => onSelectHint(entry)}
            style={{
              height: 36,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 16px",
              cursor: "pointer",
              background: rowBg,
            }}
          >
            <Clock size={14} aria-hidden="true" style={{ color: "var(--color-muted)", flexShrink: 0 }} />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 14,
                fontWeight: 400,
                color: "var(--color-fg)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {entry}
            </span>
            <button
              type="button"
              aria-label={`Remove "${entry}" from search history`}
              onMouseEnter={() => setHoveredXIdx(idx)}
              onMouseLeave={() => setHoveredXIdx((cur) => (cur === idx ? null : cur))}
              onClick={(e) => {
                e.stopPropagation();
                onRemoveHint(entry);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                flexShrink: 0,
                opacity: isRowHovered ? 1 : 0,
                color: hoveredXIdx === idx ? "var(--color-destructive)" : "var(--color-muted)",
              }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
