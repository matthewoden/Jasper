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

/**
 * breadcrumbTrail — full "Folder / Sub / Title" trail for the editor header.
 *
 * Includes all segments from root to the note title (filename minus ".md").
 * A vault-root note yields its title only (never ""). An empty path yields "".
 */
export function breadcrumbTrail(notePath: string): string {
  if (!notePath) return "";
  const parts = notePath.split("/").filter(Boolean);
  if (parts.length === 0) return "";
  // Strip .md from the last segment so the filename becomes the display title.
  const last = parts[parts.length - 1];
  parts[parts.length - 1] = last.endsWith(".md") ? last.slice(0, -3) : last;
  return parts.join(" / ");
}
