/**
 * highlightExtension — hand-rolled @lezer/markdown MarkdownConfig extension
 * adding `==highlight==` support (READ-03). Structurally templated on
 * @lezer/markdown's own bundled Strikethrough extension (`~~text~~`),
 * verified in node_modules/@lezer/markdown/dist/index.js:2020-2046.
 *
 * Flanking rule: whitespace-only (no punctuation check). Strikethrough's
 * verbatim shape also tests a `Punctuation` regex, but that symbol is a
 * private, unexported helper in @lezer/markdown — copying it verbatim would
 * hit a missing import. This is a deliberate, documented scope reduction: `==word==` still parses correctly;
 * the only edge case is punctuation-adjacent delimiters (e.g. `word==word.`)
 * being flanked slightly differently than CommonMark emphasis would be.
 */
import type { MarkdownConfig } from "@lezer/markdown";
import { tags } from "@lezer/highlight";

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

export const Highlight: MarkdownConfig = {
  defineNodes: [
    {
      name: "Highlight",
      style: { "Highlight/...": tags.inserted },
    },
    {
      name: "HighlightMark",
      style: tags.processingInstruction,
    },
  ],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        // '=' char code is 61. Three consecutive '=' does not open a highlight.
        if (next != 61 || cx.char(pos + 1) != 61 || cx.char(pos + 2) == 61) {
          return -1;
        }
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !sAfter, !sBefore);
      },
      after: "Emphasis",
    },
  ],
};
