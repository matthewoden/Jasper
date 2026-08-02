/**
 * h1Extract mirrors the server's ExtractTitle scanner. The server stays
 * authoritative for what the index stores; this exists only to detect whether
 * the H1 changed since the last save, and to derive a filename from it.
 *
 * Differs deliberately: returns null on no-H1 where Go falls back to the
 * filename, and skips Go's 1 MiB scanner cap.
 *
 * The illegal-char regex MUST agree byte-for-byte with RenameInput's. Drift
 * between the client validators is the bug class this module exists to prevent.
 */

// eslint-disable-next-line no-control-regex -- intentionally rejects ASCII control chars in user-typed names
const ILLEGAL_CHAR_REGEX = /[/\\:*?"<>|\x00-\x1F]/;

/**
 * First H1 text, or null. Frontmatter is skipped; an unclosed block is consumed
 * to EOF and yields null, matching the server.
 *
 * "# " only — `## ` is not an H1 and `#tag` is not a heading.
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
