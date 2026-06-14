/**
 * h1Extract — client-side mirror of backend/internal/markdown/title.go's
 * ExtractTitle scanner. Used by EditorPane to detect H1 changes during
 * autosave and by FileTree to rewrite the H1 in renamed note content.
 *
 * The server's ExtractTitle is authoritative for what the index stores.
 * This module exists only to detect whether the H1 changed since the last
 * save (to decide whether to dispatch moveNote) and to derive a filename
 * basename from the H1.
 *
 * Differences from the Go implementation:
 *   - Returns null on no-H1 (Go returns the filename fallback).
 *   - No 1MiB scanner buffer cap — JS string ops are O(1) on length.
 *
 * The illegal-char regex MUST agree byte-for-byte with the regex in
 * RenameInput.validateRename (which mirrors the backend's
 * notes.validateBareName). Drift between client validators is the bug
 * class this module is designed to prevent.
 */

// eslint-disable-next-line no-control-regex -- intentionally rejects ASCII control chars in user-typed names
const ILLEGAL_CHAR_REGEX = /[/\\:*?"<>|\x00-\x1F]/;

/**
 * Returns the first H1 heading text (without the "# " prefix) from
 * markdown content, or null if no H1 is present (or only frontmatter
 * / blank lines precede the first non-blank non-heading line).
 *
 * Frontmatter (--- ... ---) at the top is skipped. An unclosed
 * frontmatter is consumed to EOF and yields null (matches the
 * server's defensive behavior).
 *
 * Heading detection: trimmed line starts with "# " (single hash +
 * space). Multiple leading hashes (## ###) are NOT H1; "#tag"
 * (no space) is NOT H1.
 */
export function extractH1FromContent(content: string): string | null {
  if (!content) return null;
  const lines = content.split("\n");
  let inFrontmatter = false;
  let firstSignificantSeen = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (!firstSignificantSeen) {
      if (trimmed === "") continue;
      firstSignificantSeen = true;
      if (trimmed === "---") {
        inFrontmatter = true;
        continue;
      }
    } else if (inFrontmatter) {
      if (trimmed === "---") {
        inFrontmatter = false;
      }
      continue;
    }

    if (trimmed.startsWith("# ")) {
      return trimmed.slice(2).trim();
    }
    if (trimmed !== "") {
      return null;
    }
  }
  return null;
}

export type SanitizeResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validates an H1 string for use as a filename basename.
 * Returns { ok: true, value } or { ok: false, error }.
 *
 * Uses the same regex as RenameInput.validateRename, mirroring the
 * server's notes.validateBareName rejection set.
 */
export function sanitizeH1ForFilename(h1: string): SanitizeResult {
  const trimmed = h1.trim();
  if (trimmed === "") {
    return { ok: false, error: "Heading cannot be empty." };
  }
  if (trimmed === "." || trimmed === "..") {
    return { ok: false, error: "Heading cannot be . or .." };
  }
  if (trimmed.startsWith(".")) {
    return { ok: false, error: "Heading cannot start with a dot." };
  }
  if (ILLEGAL_CHAR_REGEX.test(trimmed)) {
    return {
      ok: false,
      error: "Heading has characters that aren't allowed in filenames.",
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Rewrites the first H1 line in the content to match newH1. If no H1
 * is present, returns the content unchanged (no auto-insert — deliberate
 * deviation from Obsidian's optional insertHeadingIfMissing behavior).
 *
 * Preserves leading whitespace on the heading line (CommonMark allows up
 * to 3 leading spaces before the `#` in an ATX heading).
 */
export function rewriteH1(content: string, newH1: string): string {
  if (!content) return content;
  const lines = content.split("\n");
  let inFrontmatter = false;
  let firstSignificantSeen = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();

    if (!firstSignificantSeen) {
      if (trimmed === "") continue;
      firstSignificantSeen = true;
      if (trimmed === "---") {
        inFrontmatter = true;
        continue;
      }
    } else if (inFrontmatter) {
      if (trimmed === "---") {
        inFrontmatter = false;
      }
      continue;
    }

    if (trimmed.startsWith("# ")) {
      const leading = rawLine.length - rawLine.trimStart().length;
      lines[i] = " ".repeat(leading) + "# " + newH1;
      return lines.join("\n");
    }
    if (trimmed !== "") {
      return content;
    }
  }
  return content;
}
