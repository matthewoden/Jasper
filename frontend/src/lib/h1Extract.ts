/**
 * h1Extract — client-side mirror of backend/internal/markdown/title.go's
 * ExtractTitle scanner. Used by EditorPane to detect H1 changes during
 * autosave (Gap R2-6 — filename↔H1 bidirectional binding per PROJECT.md
 * Key Decision dated 2026-05-03 LOCKED) and by FileTree to rewrite the
 * H1 line in the renamed note's content (Direction B of the binding).
 *
 * Source-of-truth comparison: the SERVER's markdown.ExtractTitle is
 * authoritative — what the index stores is what the tree label shows.
 * This client helper exists ONLY to detect WHETHER the H1 changed since
 * the last save (so we know to dispatch moveNote) and to compute the
 * filename basename from the H1. The actual title field on disk / in
 * the index is computed by the server's ExtractTitle on every Move
 * (Plan 03-21) and Update.
 *
 * Differences from the Go implementation:
 *   - Returns null on no-H1 (Go returns the filename fallback). Callers
 *     that want the fallback substitute it explicitly.
 *   - No 1MiB scanner buffer cap — JavaScript string ops are O(1) on
 *     length, so we don't need bufio's ErrTooLong protections.
 *
 * The illegal-char regex MUST agree byte-for-byte with the regex in
 * RenameInput.validateRename (which itself mirrors the backend's
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
 * Validates an H1 string for use as a filename basename. Returns:
 *   - { ok: true, value: <trimmed> } if the string is a legal basename
 *   - { ok: false, error: <message> } otherwise
 *
 * Uses the SAME regex as RenameInput.validateRename — matches the
 * server's notes.validateBareName rejection set (path separators,
 * control chars, empty, leading dot). Mirroring the regex prevents
 * drift between the editor's silent-fail-on-invalid-H1 and the
 * user-facing rename input.
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
 * is present, returns the content unchanged (do NOT auto-insert per
 * research §2.4 — explicit deviation from the Obsidian plugin's
 * optional insertHeadingIfMissing setting).
 *
 * Used by FileTree.handleCommitRename for the tree → H1 direction
 * (Direction B of Gap R2-6's bidirectional binding).
 *
 * Preserves leading whitespace on the heading line (CommonMark allows
 * up to 3 leading spaces before the `#` in an ATX heading); only the
 * heading text after `# ` is replaced.
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
