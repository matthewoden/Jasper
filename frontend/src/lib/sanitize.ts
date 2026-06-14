/**
 * sanitize — DOMPurify wrapper. Every `dangerouslySetInnerHTML` in the
 * codebase MUST go through sanitizeHtml(). Strips standard XSS vectors:
 * <script>, <iframe>, <object>, <embed>, <form>, on* handlers, javascript: URIs.
 *
 * SAFE_CONFIG is LOCKED — extending it requires a deliberate threat-model review.
 *   - ALLOWED_URI_REGEXP allows http(s), blob:, data:, and relative URIs only.
 *   - ADD_TAGS includes 'mark' for FTS5 search-highlight rendering.
 */
import DOMPurify from "dompurify";

/** SAFE_CONFIG — LOCKED (do not extend without an updated threat model). */
const SAFE_CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  USE_PROFILES: { html: true },
  ALLOWED_ATTR: ["href", "title", "alt", "src", "class"],
  ADD_TAGS: ["mark"],
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|blob|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
};

/**
 * sanitizeHtml — strips XSS vectors from the input HTML string.
 * Never throws; DOMPurify coerces edge cases to a string before sanitizing.
 */
export function sanitizeHtml(input: string): string {
  return DOMPurify.sanitize(input, SAFE_CONFIG);
}
