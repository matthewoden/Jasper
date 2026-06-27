/**
 * breadcrumbPrefix — the folder portion of a note path, for the active tab pill.
 *
 * Returns the parent folder segments joined by " / " (no filename, no ".md").
 * A vault-root note (no folders) yields "". Distilled from the old Breadcrumbs
 * path→segments logic; the note title is rendered separately by the tab pill.
 */
export function breadcrumbPrefix(notePath: string): string {
  const parts = notePath.split("/").filter(Boolean);
  // Drop the last segment (the filename); join the remaining folders.
  return parts.slice(0, -1).join(" / ");
}
