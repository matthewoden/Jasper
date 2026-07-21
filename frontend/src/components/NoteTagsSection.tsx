/**
 * NoteTagsSection — active note's live-parsed tag chips (Tags tab upper
 * section, TAGS-02 D-06..D-10). Tag names come from the live CM6 doc via
 * useNoteTagsStore (Plan 04); per-tag counts come from the index via
 * useTagBrowser (may lag the live parse by one keystroke — acceptable, D-08).
 *
 * Click routes to the same target as the vault tag list: opens the left
 * Search panel seeded with a `tag:{name}` query (D-07).
 *
 * Mounted by RightRail.tsx under its own RightRailSubHeader ("Note tags" +
 * count) — this component renders the chip row / empty states only.
 */
import type { CSSProperties } from "react";
import { useNoteTagsStore } from "../lib/useNoteTagsFromDoc";
import { useTagBrowser } from "../lib/useTagBrowser";
import { useTreeStore } from "../lib/useTreeStore";
import { sortTagsByCountDesc } from "../lib/tagSort";

interface Props {
  /** UUID of the currently open note. Null when no note is open. */
  activeNoteId: string | null;
}

const sectionStyle: CSSProperties = {
  flex: "none",
  maxHeight: "30vh",
  overflowY: "auto",
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  padding: "8px 24px",
  gap: 8,
};

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "baseline",
  gap: 4,
  padding: "2px 9px",
  borderRadius: 10,
  background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
  border: "none",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 400,
  lineHeight: 1.3,
  color: "var(--color-accent)",
};

const chipCountStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 400,
  color: "var(--color-muted)",
};

const emptyStateStyle: CSSProperties = {
  padding: "24px 16px",
  textAlign: "center",
  fontSize: 12,
  fontStyle: "italic",
  color: "var(--color-muted)",
};

function selectTagInSearch(name: string): void {
  useTreeStore.getState().setSidebarPanel("search");
  useTreeStore.getState().setSearchQuery(`tag:${name}`);
}

export function NoteTagsSection({ activeNoteId }: Props) {
  const noteTags = useNoteTagsStore((s) => s.noteTags);
  const { tags: vaultTags } = useTagBrowser();

  if (activeNoteId === null) {
    return (
      <div style={sectionStyle}>
        <p role="status" style={emptyStateStyle}>
          No note open
        </p>
      </div>
    );
  }

  if (noteTags.length === 0) {
    return (
      <div style={sectionStyle}>
        <p role="status" style={emptyStateStyle}>
          No tags on this note
        </p>
      </div>
    );
  }

  const countByName = new Map(vaultTags.map((t) => [t.name, t.count]));
  const items = sortTagsByCountDesc(
    noteTags.map((name) => ({ name, count: countByName.get(name) ?? 0 })),
  );

  return (
    <div style={sectionStyle}>
      <div style={rowStyle}>
        {items.map((tag) => (
          <button
            key={tag.name}
            type="button"
            data-testid={`note-tag-chip-${tag.name}`}
            style={chipStyle}
            onClick={() => selectTagInSearch(tag.name)}
          >
            <span>#{tag.name}</span>
            <span style={chipCountStyle}>&middot; {tag.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
