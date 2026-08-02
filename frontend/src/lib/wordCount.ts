/**
 * wordCount — client-side word counter for the breadcrumb band's live count.
 *
 * countWords adapts the frontmatter-skip state machine from h1Extract.ts's
 * extractH1FromContent (leading "---" opens, next "---" closes, only when
 * "---" is the first significant line) but accumulates over the WHOLE body
 * instead of returning early on the first heading.
 */

const WORD_REGEX = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/**
 * Counts words in markdown content, excluding YAML frontmatter and
 * including code-block content. Words are runs of letters/numbers
 * with optional internal apostrophe/hyphen; standalone markdown punctuation
 * (`#`, `-`, ` ``` `, `---`) contributes 0.
 */
export function countWords(markdown: string): number {
  if (!markdown) return 0;
  const lines = markdown.split("\n");
  let inFrontmatter = false;
  let firstSignificantSeen = false;
  let total = 0;

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

    const matches = trimmed.match(WORD_REGEX);
    if (matches) total += matches.length;
  }

  return total;
}

/**
 * Formats a word count as "N words" (or "1 word" for the singular case),
 * with a thousands separator.
 */
export function formatWordCount(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "word" : "words"}`;
}
