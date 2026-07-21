/**
 * tagSort — shared count-desc/alpha-tie comparator for tag lists (D-09).
 *
 * Used by both NoteTagsSection.tsx (active-note tags) and
 * RightRailTagsPanel.tsx (vault-wide tag list) so the two Tags-tab sections
 * always order identically.
 */
export interface TagCountItem {
  name: string;
  count: number;
}

export function sortTagsByCountDesc<T extends TagCountItem>(items: T[]): T[] {
  return [...items].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
