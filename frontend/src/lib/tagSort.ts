/**
 * tagSort — shared count-desc/alpha-tie comparator for tag lists.
 *
 * Used by RightRailTagsPanel.tsx (the Tags tab's single vault-wide tag list,
 * the prior active-note NoteTagsSection.tsx having been deleted).
 */
export interface TagCountItem {
  name: string;
  count: number;
}

export function sortTagsByCountDesc<T extends TagCountItem>(items: T[]): T[] {
  return [...items].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
