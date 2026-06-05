/**
 * URL classification helpers — shared by livePreviewPlugin (visual
 * styling + ↗ icon decision) and linkClickHandler (whether to
 * intercept a modifier-click and where to open it).
 *
 * "External-like" covers two cases:
 *   1. Explicit protocol: http(s)://
 *   2. Bare domain with TLD: "example.com", "a.b.org/path",
 *      "subdomain.deep.example.io"
 *
 * Bare domains are upgraded to https:// at open time so the browser
 * navigates correctly. The bar for "is this a URL" is intentionally
 * loose — markdown link bodies that don't match are treated as
 * relative paths or wiki refs and left to Phase 6 routing.
 *
 * Anti-patterns this gate explicitly EXCLUDES:
 *   - Anchors:        "#section"
 *   - Relative paths: "./foo", "/foo", "foo/bar.md"
 *   - mailto/tel:     these have their own protocols; not opened by
 *                     this handler (extend later if needed)
 */

const PROTOCOL_RE = /^https?:\/\//i;


const BARE_DOMAIN_RE =
  /^([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}(\/[^\s]*)?(\?[^\s#]*)?(#[^\s]*)?$/i;


const FILE_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "rst",
  "html",
  "htm",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "ico",
  "bmp",
  "zip",
  "tar",
  "gz",
  "mp3",
  "mp4",
  "mov",
  "wav",
  "js",
  "ts",
  "json",
  "css",
  "yml",
  "yaml",
]);

function looksLikeRelativeFile(url: string): boolean {
  const head = url.split(/[/?#]/)[0];
  if (!head.includes(".")) return false;
  const lastSegment = head.slice(head.lastIndexOf(".") + 1).toLowerCase();
  return FILE_EXTENSIONS.has(lastSegment);
}

export function isExternalLikeUrl(raw: string): boolean {
  if (!raw) return false;
  const url = raw.trim();
  if (PROTOCOL_RE.test(url)) return true;
  if (!BARE_DOMAIN_RE.test(url)) return false;
  if (looksLikeRelativeFile(url)) return false;
  return true;
}

export function ensureProtocol(raw: string): string {
  const url = raw.trim();
  if (PROTOCOL_RE.test(url)) return url;
  return "https://" + url;
}
