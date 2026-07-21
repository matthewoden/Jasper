/**
 * inlineTagPlugin — CM6 ViewPlugin that decorates `#tagname` occurrences in
 * the document body as clickable styled spans.
 *
 * Uses MatchDecorator with `/#([a-z0-9_-]+)/g`. lezer-markdown has no HashTag
 * node, so regex matching is the only option (same rationale as wikilinkPlugin).
 *
 * Decoration.mark (not replace) so #tagname text stays visible when the cursor
 * is inside it — avoids needing a per-cursor-line guard.
 *
 * isInsideCodeOrFrontmatter and isHeadingLine guards prevent decorating tags
 * inside code blocks, inline code, frontmatter, and markdown headings. Both
 * guards are copied (not imported) from wikilinkPlugin for independent testability.
 *
 * Click handler calls useTreeStore.getState().setActiveTagFilter() via the
 * module-level getState() pattern — safe from outside the React render tree.
 *
 * data-tag is constrained to `[a-z0-9_-]+` by the regex; passed to Zustand
 * as a plain string with no innerHTML path.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { Text } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import { useTreeStore } from "../lib/useTreeStore";


/**
 * Matches #tagname where tagname = [a-z0-9_-]+. Lowercase only — the backend
 * normalizes to lowercase on save, so uppercase tags won't exist in practice,
 * but the frontend also enforces it so `#FOO` is never decorated.
 *
 * Exported so tagExtract.ts (the pure, whole-document extractor backing the
 * Tags tab, TAGS-02) reuses the exact same pattern rather than redeclaring it.
 */
export const INLINE_TAG_RE = /#([a-z0-9_-]+)/g;


/**
 * Returns true when the position is inside code or frontmatter (FencedCode,
 * CodeBlock, InlineCode, Frontmatter). Copied from wikilinkPlugin for
 * independent testability.
 *
 * Takes a `Tree` (not a view) so tagExtract.ts can pass in a fully-parsed
 * whole-document tree (via ensureSyntaxTree, mirroring outlineExtract.ts)
 * instead of the viewport-scoped tree this plugin's own decorate() sees.
 */
export function isInsideCodeOrFrontmatter(tree: Tree, from: number): boolean {
  let node = tree.resolveInner(from);
  while (node) {
    const name = node.name;
    if (
      name === "FencedCode" ||
      name === "CodeBlock" ||
      name === "InlineCode" ||
      name === "Frontmatter"
    ) {
      return true;
    }
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}


/**
 * Returns true when the position is on a markdown heading line (starts with `# ` or `## `).
 * Prevents a `#tag`-looking token elsewhere on the same heading line (e.g.
 * `# Meeting #notes`) from being treated as a tag.
 */
export function isHeadingLine(doc: Text, from: number): boolean {
  const line = doc.lineAt(from);
  const text = line.text;
  if (text.length === 0 || text[0] !== "#") return false;
  return text[1] === " " || text[1] === "#";
}


const inlineTagMatcher = new MatchDecorator({
  regexp: INLINE_TAG_RE,
  decorate(add, from, to, match, view) {
    if (isInsideCodeOrFrontmatter(syntaxTree(view.state), from)) return;
    if (isHeadingLine(view.state.doc, from)) return;

    const tagName = match[1];
    add(
      from,
      to,
      Decoration.mark({
        class: "cm-inline-tag",
        attributes: { "data-tag": tagName },
      }),
    );
  },
});


/**
 * inlineTagPlugin — the exported CM6 extension.
 * IME composing → map decorations; doc/viewport/syntax change → updateDeco.
 * Click handler reads `data-tag` attribute, falls back to stripping `#` from textContent.
 */
export const inlineTagPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = inlineTagMatcher.createDeco(view);
    }

    update(u: ViewUpdate) {
      if (u.view.composing) {
        this.decorations = this.decorations.map(u.changes);
        return;
      }
      if (
        u.docChanged ||
        u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = inlineTagMatcher.updateDeco(u, this.decorations);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      click(e: MouseEvent) {
        const target = e.target as HTMLElement | null;
        if (!target || !target.classList.contains("cm-inline-tag")) return false;

        const tagName =
          target.getAttribute("data-tag") ??
          (target.textContent?.startsWith("#")
            ? target.textContent.slice(1)
            : target.textContent ?? "");

        if (tagName) {
          useTreeStore.getState().setActiveTagFilter(tagName);
        }
        return true;
      },
    },
  },
);
