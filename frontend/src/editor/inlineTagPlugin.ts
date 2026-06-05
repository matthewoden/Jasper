/**
 * inlineTagPlugin — CM6 ViewPlugin that decorates `#tagname` occurrences in
 * the document body as clickable styled spans.
 *
 * Phase 6.5 / Plan 06.5-05 / UX-T-02.
 *
 * Design decisions:
 *
 *   - Uses MatchDecorator (from @codemirror/view) with global regex
 *     `/#([a-z0-9_-]+)/g`. lezer-markdown has NO HashTag node, so regex
 *     matching over body text is the correct approach (mirrors wikilinkPlugin).
 *
 *   - Decoration.mark (NOT Decoration.replace) so #tagname text stays visible
 *     even when the cursor is inside it. Pitfall 2 from RESEARCH.md: if we used
 *     Decoration.replace, the text would disappear under the cursor, requiring
 *     an on-cursor-line guard. Mark avoids that complexity entirely.
 *
 *   - D-19 code-context guard (isInsideCodeOrFrontmatter): reused verbatim from
 *     wikilinkPlugin — walks the syntax tree at the match position; suppresses
 *     decoration inside FencedCode, CodeBlock, InlineCode, or Frontmatter nodes.
 *     Both files deliberately copy the function to remain independently testable.
 *
 *   - Heading guard (isHeadingLine): inline tags on lines beginning with
 *     `# ` (h1) or `## ` (h2+) are skipped. Pitfall 5 from RESEARCH.md: the
 *     regex `/#([a-z0-9_-]+)/g` would match the second `#` in `## todo` as tag
 *     `#todo`. The per-line check prevents this.
 *
 *   - IME gate: u.view.composing → map existing decorations through u.changes
 *     instead of rebuilding. Matches wikilinkPlugin pattern.
 *
 *   - Click handler via eventHandlers in ViewPlugin.fromClass options. Reads
 *     `data-tag` attribute set by the MatchDecorator's decorate callback.
 *     Strips the leading `#` if reading from textContent fallback.
 *     Calls useTreeStore.getState().setActiveTagFilter(tagName) — note the
 *     import uses the module-level getState() pattern (not a React hook) so it
 *     is safe to call from a DOM event handler outside the React render tree.
 *
 * CSS classes (add to index.css — Plan 07's job; this plugin emits the class):
 *   .cm-inline-tag        — blue text via --color-accent; cursor: pointer
 *   .cm-inline-tag:hover  — subtle background tint
 *
 * XSS surface (T-06.5-13): `data-tag` is set to `match[1]` which the regex
 * constrains to `[a-z0-9_-]+`. Even so, `getAttribute` returns a plain string
 * that is passed to a Zustand setter — no innerHTML path; XSS impossible.
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
import { useTreeStore } from "../lib/useTreeStore";


/**
 * Matches #tagname where tagname = [a-z0-9_-]+.
 * Capture group [1] is the tagname WITHOUT the leading `#`.
 *
 * Constraint: lowercase only — uppercase is excluded so `#FOO` is not
 * decorated. The backend normalizes to lowercase on save, but the frontend
 * rendering rule is strict: only decorated if already lowercase (v1 limitation
 * documented in Plan 06.5-05 SUMMARY).
 */
const INLINE_TAG_RE = /#([a-z0-9_-]+)/g;


/**
 * Returns true if the position is inside any code or frontmatter context
 * that should suppress inline-tag decoration.
 *
 * Walks the parent chain from the innermost node at `from`. Any of these
 * node types in the ancestor chain suppresses the decoration:
 *   FencedCode   — fenced ``` block
 *   CodeBlock    — indented code block
 *   InlineCode   — `code` span
 *   Frontmatter  — YAML front-matter block
 *
 * Deliberately copied (not imported) from wikilinkPlugin to keep this plugin
 * independently testable without creating a circular or shared utility module.
 */
function isInsideCodeOrFrontmatter(view: EditorView, from: number): boolean {
  let node = syntaxTree(view.state).resolveInner(from);
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
 * Returns true if the position is on a markdown heading line.
 *
 * A heading line starts with `#` followed immediately by a space OR another `#`.
 *   `# Heading` → true
 *   `## Heading` → true
 *   `#tagname` → false (no space after #, not a heading marker)
 *
 * This prevents `## todo` from being decorated: the second `#todo` would
 * otherwise match the regex. Pitfall 5 from RESEARCH.md; the same logic is
 * used in ExtractBodyTags on the backend.
 */
function isHeadingLine(view: EditorView, from: number): boolean {
  const line = view.state.doc.lineAt(from);
  const text = line.text;
  if (text.length === 0 || text[0] !== "#") return false;
  return text[1] === " " || text[1] === "#";
}


const inlineTagMatcher = new MatchDecorator({
  regexp: INLINE_TAG_RE,
  decorate(add, from, to, match, view) {
    if (isInsideCodeOrFrontmatter(view, from)) return;
    if (isHeadingLine(view, from)) return;

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
 * The exported CM6 extension. Slot into MarkdownEditor's extensions array
 * alongside wikilinkPlugin and tagClickPlugin.
 *
 * Update strategy:
 *   - IME composing → map existing decorations (no rebuild)
 *   - docChanged, viewportChanged, or syntax-tree change → updateDeco
 *
 * Click handler: registered in the eventHandlers option. Reads the
 * `data-tag` attribute from the clicked element (set by the decorate callback).
 * Falls back to stripping `#` from textContent if attribute is missing.
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
