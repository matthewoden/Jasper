/**
 * tagExtract — extracts `#tagname` occurrences from the LIVE CM6 document,
 * reusing the exact regex + guards inlineTagPlugin.ts already ships for its
 * click-to-filter decorations (TAGS-02). lezer-markdown has no HashTag node,
 * so regex matching — not an AST walk — is the only option here (see
 * inlineTagPlugin.ts's own doc comment).
 *
 * Unlike inlineTagPlugin's viewport-scoped MatchDecorator, this extractor
 * scans the WHOLE document (mirrors outlineExtract.ts's ensureSyntaxTree
 * pattern) since the Tags tab needs every tag on the note, not just the
 * ones currently on screen.
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

import {
  INLINE_TAG_RE,
  isHeadingLine,
  isInsideCodeOrFrontmatter,
} from "./inlineTagPlugin";

/**
 * extractTags — returns the deduped `#tagname` list for the document, in
 * first-appearance order. Skips matches inside code blocks, inline code,
 * frontmatter, and heading lines (same guards as inlineTagPlugin).
 */
export function extractTags(state: EditorState): string[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const text = state.doc.toString();

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const match of text.matchAll(INLINE_TAG_RE)) {
    const from = match.index ?? 0;
    if (isInsideCodeOrFrontmatter(tree, from)) continue;
    if (isHeadingLine(state.doc, from)) continue;

    const tagName = match[1];
    if (!seen.has(tagName)) {
      seen.add(tagName);
      tags.push(tagName);
    }
  }

  return tags;
}
