/**
 * sanitize — DOMPurify wrapper. Phase 5 SECURITY-02 / D-36.
 *
 * Phase 5 has ZERO callers. The wrapper exists so Phase 6 (backlinks
 * panel HTML render surface) and Phase 7 (command-palette result
 * snippets) have a single mandated entry point that strips the
 * standard XSS vectors:
 *   - <script>, <iframe>, <object>, <embed>, <form> tags removed
 *   - on* event handlers stripped
 *   - javascript: URIs blocked
 *
 * Drift policy: every `dangerouslySetInnerHTML` in the codebase MUST
 * go through sanitizeHtml(). A future eslint custom rule (Phase 6
 * Deferred Idea per CONTEXT.md) will enforce this; for v1 the rule
 * is a code-review convention.
 *
 * SAFE_CONFIG values are LOCKED — extending them requires a follow-on
 * planning round so the threat model stays tight.
 *   - USE_PROFILES.html — DOMPurify's standard HTML allowlist
 *   - ALLOWED_ATTR — explicit list of legitimate attributes Phase 6+
 *     will need on links/images/spans
 *   - ALLOWED_URI_REGEXP — http(s), blob:, data:, and relative URIs
 *     only (matches the editor's external-image widget allowance from
 *     Plan 05-08)
 *   - FORBID_TAGS / FORBID_ATTR — defense-in-depth on top of the
 *     profile allowlist
 */
import DOMPurify from "dompurify";

/**
 * SAFE_CONFIG — LOCKED (do not extend without an updated threat
 * model). Plan 05-09 / SECURITY-02.
 */
const SAFE_CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  USE_PROFILES: { html: true },
  // Whitelist of attributes legitimate Phase 6+ surfaces will need:
  //   href, title — for backlinks and inline links
  //   alt, src    — for image rendering (paired with the editor's
  //                 external-image widget for cross-origin URLs)
  //   class       — for CSS hooks (cm-* classes etc.)
  ALLOWED_ATTR: ["href", "title", "alt", "src", "class"],
  // Permit http(s), blob:, data:, relative URIs, fragments. Blocks
  // javascript:, vbscript:, file: schemes. Pattern from DOMPurify docs.
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|blob|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
  // Defense-in-depth: profile already excludes most of these but
  // FORBID_TAGS makes the boundary explicit and grep-able.
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
};

/**
 * sanitizeHtml — strips XSS vectors from the input HTML string.
 *
 * Returns a sanitized string. Never throws; on edge cases (null,
 * undefined, non-string) DOMPurify coerces to a string before
 * sanitizing. Caller is responsible for passing a string.
 *
 * Usage (Phase 6+):
 *   const safe = sanitizeHtml(serverSnippet);
 *   element.innerHTML = safe;
 */
export function sanitizeHtml(input: string): string {
  return DOMPurify.sanitize(input, SAFE_CONFIG);
}
