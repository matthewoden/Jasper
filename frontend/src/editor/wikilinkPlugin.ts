/**
 * wikilinkPlugin decorates [[Title]] and [[Title|Alias]] as clickable spans.
 *
 * MatchDecorator over line text, not syntax-tree iteration: lezer-markdown has
 * no WikiLink node.
 *
 * Decoration.replace, not mark — a mark would leave the raw brackets and pipe
 * visible on an aliased link.
 *
 * WidgetType.ignoreEvent MUST return false, or CM6 consumes clicks before
 * linkClickHandler sees them.
 *
 * The raw markup stays visible on the cursor's own line so it can be edited.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { getResolvedTitlesSnapshot } from "./wikilinkResolver";


/**
 * Dispatching this effect forces a full createDeco() rebuild on the next
 * update cycle. MarkdownEditor fires it from the useEffect that updates the
 * module-level snapshot whenever useResolvedTitleSet() returns a new Set.
 *
 * An effect is needed (not just selectionSet / docChanged) because
 * MatchDecorator.updateDeco() only rebuilds on doc or viewport changes;
 * external state changes require an explicit effect to trigger createDeco().
 */
export const resolvedTitlesChanged = StateEffect.define<void>();


/**
 * match[1] is the target, match[2] the optional alias.
 *
 * [^\]
] stops the match consuming past the closing ]] or across a newline;
 * the lazy quantifiers stop it swallowing a second wikilink on the same line.
 */
export const WIKILINK_RE = /\[\[([^\]\n]+?)(?:\|([^\]\n]+?))?\]\]/g;


/**
 * Security: textContent, never innerHTML — displayText is user-controlled.
 *
 * data-wikilink-title carries the raw title so linkClickHandler need not
 * re-parse the document.
 */
export class WikiLinkWidget extends WidgetType {
  constructor(
    public readonly displayText: string,
    public readonly isResolved: boolean,
    public readonly targetId: string | null,
    public readonly rawTitle: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.isResolved ? "cm-wiki-link" : "cm-wiki-link-pending";
    span.textContent = this.displayText;
    span.setAttribute("data-wikilink-title", this.rawTitle);
    if (this.targetId) {
      span.setAttribute("data-target-id", this.targetId);
    }
    return span;
  }

  eq(other: WidgetType): boolean {
    if (!(other instanceof WikiLinkWidget)) return false;
    return (
      other.displayText === this.displayText &&
      other.isResolved === this.isResolved &&
      other.targetId === this.targetId &&
      other.rawTitle === this.rawTitle
    );
  }

  /**
   * Return false so click events bubble to the editor's DOM event handlers
   * and reach linkClickHandler. Returning true would cause CM6 to consume
   * clicks before our handler sees them.
   */
  ignoreEvent(): boolean {
    return false;
  }
}


/**
 * Returns true if the position is inside any code or frontmatter context
 * that should suppress wiki-link decoration.
 *
 * Walks the parent chain from the innermost node at `pos`. Any of these
 * node types in the ancestor chain suppresses the decoration:
 *   FencedCode, CodeBlock, InlineCode, Frontmatter.
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


function computeCursorLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const startLine = view.state.doc.lineAt(range.from).number;
    const endLine = view.state.doc.lineAt(range.to).number;
    for (let n = startLine; n <= endLine; n++) lines.add(n);
  }
  return lines;
}


const wikilinkMatcher = new MatchDecorator({
  regexp: WIKILINK_RE,
  decorate(add, from, to, match, view) {
    if (isInsideCodeOrFrontmatter(view, from)) return;

    const cursorLines = computeCursorLines(view);
    const lineNum = view.state.doc.lineAt(from).number;
    if (cursorLines.has(lineNum)) return;

    const rawTitle = match[1];
    const alias = match[2];
    const displayText = alias ?? rawTitle;

    const { titles, idMap } = getResolvedTitlesSnapshot();
    const lower = rawTitle.normalize("NFC").toLowerCase();
    const resolved = titles.has(lower);
    const targetId = idMap?.get(lower) ?? null;

    add(
      from,
      to,
      Decoration.replace({
        widget: new WikiLinkWidget(displayText, resolved, targetId, rawTitle),
      }),
    );
  },
});


/**
 * Rebuilds on doc/viewport/tree change, but only MAPS existing decorations
 * while an IME composition is active.
 *
 * Resolved-state changes land on the next update; resolvedTitlesChanged forces
 * an immediate rebuild without a doc change.
 */
export const wikilinkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = wikilinkMatcher.createDeco(view);
    }

    update(u: ViewUpdate) {
      if (u.view.composing) {
        this.decorations = this.decorations.map(u.changes);
        return;
      }
      const titlesRefreshed = u.transactions.some((tr) =>
        tr.effects.some((e) => e.is(resolvedTitlesChanged)),
      );
      if (titlesRefreshed) {
        this.decorations = wikilinkMatcher.createDeco(u.view);
        return;
      }
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = wikilinkMatcher.updateDeco(u, this.decorations);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
