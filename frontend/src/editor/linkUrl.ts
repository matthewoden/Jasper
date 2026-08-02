/**
 * URL classification shared by livePreviewPlugin (styling) and linkClickHandler
 * (whether to intercept a click).
 *
 * "External-like" means an explicit http(s) protocol OR a bare domain with a
 * TLD, which is upgraded to https at open time so the browser navigates.
 *
 * The bar is deliberately loose: anything that fails it is treated as a relative
 * path or wiki ref. Anchors, relative paths and mailto/tel are excluded.
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
