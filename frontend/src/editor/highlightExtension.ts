/**
 * Hand-rolled @lezer/markdown extension adding `==highlight==`, templated on that
 * package's own bundled Strikethrough extension.
 *
 * The flanking rule is whitespace-only. Strikethrough also tests a `Punctuation`
 * regex, but that helper is private and unexported, so copying it verbatim would
 * not compile. Deliberate scope reduction: `==word==` still parses; only
 * punctuation-adjacent delimiters flank differently than CommonMark emphasis.
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
