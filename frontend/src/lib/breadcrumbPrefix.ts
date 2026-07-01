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

/**
 * BreadcrumbSegment — one segment in a note's breadcrumb trail.
 *
 * Each folder in the path yields a "folder" segment; the final filename yields
 * a "note" segment with ".md" stripped from its label. The folderPath is the
 * cumulative vault-relative path up to and including this segment.
 */
export type BreadcrumbSegment = {
  label: string;      // display text (folder name or note title without .md)
  folderPath: string; // vault-relative path this segment maps to (for reveal)
  kind: "folder" | "note";
};

/**
 * breadcrumbSegments — split a note path into typed segments for interactive
 * breadcrumb rendering (SET2-06/07).
 *
 * Returns one entry per path segment in order from root to note title.
 * A vault-root note returns a single note segment.
 * An empty path returns [].
 */
export function breadcrumbSegments(notePath: string): BreadcrumbSegment[] {
  if (!notePath) return [];
  const parts = notePath.split("/").filter(Boolean);
  if (parts.length === 0) return [];
  return parts.map((part, i) => {
    const isLast = i === parts.length - 1;
    const folderPath = parts.slice(0, i + 1).join("/");
    const label = isLast
      ? (part.endsWith(".md") ? part.slice(0, -3) : part)
      : part;
    return { label, folderPath, kind: isLast ? "note" : "folder" };
  });
}
