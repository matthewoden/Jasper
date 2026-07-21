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

/**
 * Stable per-heading identity for session fold state. The heading list is
 * rebuilt on every doc change, so positional indices would fold the wrong
 * section after an insert/delete above a collapsed heading; level + text +
 * occurrence ordinal survives those edits.
 */
function headingKeys(headings: { level: number; text: string }[]): string[] {
  const seen = new Map<string, number>();
  return headings.map((h) => {
    const base = `${h.level}:${h.text}`;
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    return `${base}:${ordinal}`;
  });
}

export function OutlinePanel() {
  const outlineHeadings = useOutlineStore((s) => s.outlineHeadings);
  const scrollToHeading = useOutlineStore((s) => s.scrollToHeading);
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());

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

  const toggleCollapsed = (key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const keys = headingKeys(outlineHeadings);
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
    const isCollapsed = isParent && collapsedKeys.has(keys[i]);
    if (isCollapsed) {
      hideUntilLevel = heading.level;
    }

    rows.push(
      <div
        key={keys[i]}
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
          paddingRight: 24,
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
              toggleCollapsed(keys[i]);
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
    // role="group" (not "list"): ARIA requires list children to be listitem,
    // but every row here is an interactive role="button".
    <div role="group" aria-label="Note outline">
      <style>
        {`.outline-row:hover { background: color-mix(in srgb, var(--color-muted) 8%, transparent); }`}
      </style>
      {rows}
    </div>
  );
}
