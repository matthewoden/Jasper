/**
 * tagSort — shared count-desc/alpha-tie comparator for tag lists (D-09).
 *
 * Used by RightRailTagsPanel.tsx (the Tags tab's single vault-wide tag list,
 * D-03 — the prior active-note NoteTagsSection.tsx was deleted per D-05).
 */
export interface TagCountItem {
  name: string;
  count: number;
}

export function sortTagsByCountDesc<T extends TagCountItem>(items: T[]): T[] {
  return [...items].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
