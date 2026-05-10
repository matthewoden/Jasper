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

// Bare-domain heuristic: ONE OR MORE labels (letters/digits/hyphens),
// each followed by a dot, ending with a 2+-letter TLD-ish token.
// Trailing path / query / hash is optional. The 2+ TLD threshold
// rules out single-character extensions and the no-whitespace tail
// keeps the match strict enough that bracketed URL syntax doesn't
// false-positive.
//
// Examples that match: test.com, a.b.org, sub.deep.example.io,
//                      example.com/path, example.com?q=1, example.com#a
// Examples that DON'T:  ./foo, /foo, #anchor, x.y.z (z<2), just-text
const BARE_DOMAIN_RE =
  /^([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}(\/[^\s]*)?(\?[^\s#]*)?(#[^\s]*)?$/i;

// Markdown users frequently write relative links to other vault
// files: `[my note](other.md)`, `[diagram](images/foo.svg)`. These
// happen to fit the bare-domain regex (`name.ext` with a 2+ char
// "TLD"), so we exclude well-known FILE extensions to keep the heuristic
// honest. The list mirrors the kinds of files Jasper's vault stores
// or links to today; expand if/when we add more.
//
// The exclusion check fires AFTER the bare-domain regex matches and
// looks at the last dot-separated segment of the path-less URL head.
const FILE_EXTENSIONS = new Set([
  // notes / docs
  "md",
  "markdown",
  "txt",
  "rst",
  "html",
  "htm",
  "pdf",
  // images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "ico",
  "bmp",
  // attachments
  "zip",
  "tar",
  "gz",
  "mp3",
  "mp4",
  "mov",
  "wav",
  // code-ish
  "js",
  "ts",
  "json",
  "css",
  "yml",
  "yaml",
]);

function looksLikeRelativeFile(url: string): boolean {
  // Strip path / query / hash so we examine only the "host-like" head.
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
  // Looks domain-like, but if the last extension is a known file
  // extension treat it as a relative link (vault file reference)
  // instead of an external URL.
  if (looksLikeRelativeFile(url)) return false;
  return true;
}

export function ensureProtocol(raw: string): string {
  const url = raw.trim();
  if (PROTOCOL_RE.test(url)) return url;
  return "https://" + url;
}
