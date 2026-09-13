/**
 * The two halves of an attachment reference, kept together because they have to
 * agree: what gets written into a note, and what gets requested off the server.
 *
 * A filename with a space is not a legal CommonMark link destination, so an
 * unencoded `![x](attachments/holiday photo.png)` renders in Jasper — the
 * editor widgets match with a regex — and nowhere else. Encoding on the way in
 * is what keeps a note readable by any other markdown tool.
 */

export const ATTACHMENT_REF_PREFIX = "attachments/";

/**
 * Encodes a vault path for use as a markdown link destination, escaping each
 * segment but leaving the separators alone. encodeURIComponent on the whole
 * path would escape the slashes too.
 *
 * Parentheses are escaped on top of encodeURIComponent, which leaves them
 * alone: an unbalanced `)` in a filename ends the destination early, both for
 * CommonMark and for the editor widgets' own `[^)]+` match.
 */
export function encodeAttachmentPath(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29")
    )
    .join("/");
}

/**
 * The filename as it exists on disk, given a reference as written in a note.
 * Tolerates an unencoded reference so notes authored before encoding, or by
 * hand, still resolve.
 */
export function decodeAttachmentFilename(src: string): string {
  const withoutPrefix = src.startsWith(ATTACHMENT_REF_PREFIX)
    ? src.slice(ATTACHMENT_REF_PREFIX.length)
    : src;
  try {
    return decodeURIComponent(withoutPrefix);
  } catch {
    // A lone % is not a valid escape and throws; it is then a literal filename.
    return withoutPrefix;
  }
}

/**
 * The request URL for an attachment reference. Decodes first: re-encoding an
 * already-encoded reference asks the server for a file whose name contains a
 * literal "%20".
 */
export function attachmentRequestUrl(noteId: string, src: string): string {
  const filename = decodeAttachmentFilename(src);
  return `/api/v1/attachments/${encodeURIComponent(noteId)}/${encodeURIComponent(filename)}`;
}
