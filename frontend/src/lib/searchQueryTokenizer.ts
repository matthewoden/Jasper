export interface ParsedSearchQuery {
  tags: string[];
  text: string;
}

const TAG_PREFIX = "tag:";

/**
 * parseSearchQuery — splits `tag:name` terms out of a raw search query,
 * leaving the remaining free text. Case-sensitive prefix (matches Obsidian).
 *
 * Split-then-prefix-check is O(n) — no backtracking regex over the full
 * string (ReDoS mitigation, T-19-08).
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const tags: string[] = [];
  const textParts: string[] = [];

  for (const token of tokens) {
    if (token.startsWith(TAG_PREFIX)) {
      const name = token.slice(TAG_PREFIX.length);
      if (name.length > 0 && !tags.includes(name)) {
        tags.push(name);
      }
    } else {
      textParts.push(token);
    }
  }

  return { tags, text: textParts.join(" ") };
}
