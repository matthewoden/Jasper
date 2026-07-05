/**
 * OutlinePanel — indented, collapsible heading list for the active note's
 * live CM6 document (RSIDE-01).
 *
 * Body-only component: no section header (SectionHeader wraps this in
 * plan 04's RightRail rework). Reads outlineHeadings + scrollToHeading from
 * useOutlineStore (written by the active MarkdownEditor instance).
 *
 * Fold state is session-level (component useState, not persisted) per
 * CONTEXT.md's explicit discretion grant (D-14) — collapsing a parent hides
 * every row until the next heading at an equal-or-shallower level.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { useOutlineStore } from "../lib/useOutlineStore";

const ROW_HEIGHT = 28;
const INDENT_BASE = 8;
const INDENT_STEP = 12;

function indentForLevel(level: number): number {
  return INDENT_BASE + (level - 1) * INDENT_STEP;
}

export function OutlinePanel() {
  const outlineHeadings = useOutlineStore((s) => s.outlineHeadings);
  const scrollToHeading = useOutlineStore((s) => s.scrollToHeading);
  const [collapsedIndices, setCollapsedIndices] = useState<Set<number>>(
    new Set(),
  );

  if (outlineHeadings.length === 0) {
    return (
      <div>
        <div
          style={{
            padding: "24px 16px",
            textAlign: "center",
            fontSize: 12,
            color: "var(--color-muted)",
          }}
        >
          No headings
        </div>
        <div
          style={{
            padding: "0 16px 24px",
            textAlign: "center",
            fontSize: 12,
            color: "var(--color-muted)",
          }}
        >
          Add a heading to see it here.
        </div>
      </div>
    );
  }

  const toggleCollapsed = (i: number) => {
    setCollapsedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const rows: React.ReactNode[] = [];
  let hideUntilLevel: number | null = null;

  for (let i = 0; i < outlineHeadings.length; i++) {
    const heading = outlineHeadings[i];

    if (hideUntilLevel !== null) {
      if (heading.level > hideUntilLevel) {
        continue;
      }
      hideUntilLevel = null;
    }

    const isParent =
      i + 1 < outlineHeadings.length &&
      outlineHeadings[i + 1].level > heading.level;
    const isCollapsed = isParent && collapsedIndices.has(i);
    if (isCollapsed) {
      hideUntilLevel = heading.level;
    }

    rows.push(
      <div
        key={i}
        role="button"
        tabIndex={0}
        aria-label={`Go to heading: ${heading.text}`}
        onClick={() => scrollToHeading?.(heading.from)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            scrollToHeading?.(heading.from);
          }
        }}
        className="outline-row"
        style={{
          height: ROW_HEIGHT,
          display: "flex",
          alignItems: "center",
          paddingLeft: indentForLevel(heading.level),
          paddingRight: 16,
          cursor: "pointer",
        }}
      >
        {isParent ? (
          <button
            type="button"
            aria-label={
              isCollapsed
                ? `Expand "${heading.text}" section`
                : `Collapse "${heading.text}" section`
            }
            onClick={(e) => {
              e.stopPropagation();
              toggleCollapsed(i);
            }}
            style={{
              width: 12,
              height: 12,
              flexShrink: 0,
              background: "transparent",
              border: 0,
              padding: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--color-muted)",
              cursor: "pointer",
            }}
          >
            {isCollapsed ? (
              <ChevronRight size={12} aria-hidden="true" />
            ) : (
              <ChevronDown size={12} aria-hidden="true" />
            )}
          </button>
        ) : (
          <span aria-hidden="true" style={{ width: 12, flexShrink: 0 }} />
        )}
        <span aria-hidden="true" style={{ width: 4, flexShrink: 0 }} />
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 13,
            fontWeight: 400,
            color: "var(--color-fg)",
          }}
          title={heading.text}
        >
          {heading.text}
        </span>
      </div>,
    );
  }

  return (
    <div role="list" aria-label="Note outline">
      <style>
        {`.outline-row:hover { background: rgba(255,255,255,0.04); }`}
      </style>
      {rows}
    </div>
  );
}
