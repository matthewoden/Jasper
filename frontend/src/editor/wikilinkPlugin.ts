/**
 * wikilinkPlugin — CM6 ViewPlugin that decorates [[Title]] and [[Title|Alias]]
 * wikilinks as clickable styled spans.
 *
 * Design decisions:
 *
 *   - Uses MatchDecorator with a global regex. lezer-markdown has no WikiLink
 *     node, so syntax-tree iteration is not an option. MatchDecorator operates
 *     on line text and calls the decorate callback for each match in the viewport.
 *
 *   - Decoration.replace (not Decoration.mark) so off-cursor aliases render
 *     correctly: [[Title|Alias]] shows only "Alias". A mark on the full [[...]]
 *     span would still show the raw brackets and pipe.
 *
 *   - WidgetType.ignoreEvent must return false so click events propagate to the
 *     linkClickHandler. If it returns true, CM6 consumes events before our handler.
 *
 *   - Code-context guard: isInsideCodeOrFrontmatter walks the syntax tree at the
 *     match position; if inside FencedCode, CodeBlock, InlineCode, or Frontmatter,
 *     the match is skipped.
 *
 *   - IME gate: u.view.composing → map existing decorations through u.changes
 *     instead of rebuilding.
 *
 *   - Resolved-vs-pending: reads getResolvedTitlesSnapshot() from wikilinkResolver.
 *     Snapshot refresh triggers on the NEXT doc/viewport update (known caveat).
 *
 *   - On-cursor line: raw [[Title]] markup stays visible for editing. Any line
 *     containing a selection range is in the cursor-line set.
 *
 * CSS classes:
 *   .cm-wiki-link         — resolved link (accent color + underline)
 *   .cm-wiki-link-pending — pending link (dashed underline + dimmed)
 *   [data-cmd-held] ...   — pointer cursor while Cmd/Ctrl held
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
 * Matches [[Title]] and [[Title|Alias]] across a single line.
 * Capture groups:
 *   match[1] → rawTitle (the link target, before "|")
 *   match[2] → alias    (display text after "|", or undefined)
 *
 * Constraints:
 *   - [^\]\n] prevents consuming across the closing ]] or across newlines
 *   - Lazy quantifiers (+?) avoid greedy over-consumption when multiple
 *     wikilinks appear on the same line
 */
export const WIKILINK_RE = /\[\[([^\]\n]+?)(?:\|([^\]\n]+?))?\]\]/g;


/**
 * Renders the visible [[Title]] / [[Title|Alias]] replacement.
 * Off-cursor: the raw [[...]] markup is replaced by this widget's span.
 * On-cursor line: no replace decoration is emitted (raw markup visible).
 *
 * Security: textContent is used, never innerHTML — XSS is impossible
 * even though displayText is user-controlled.
 *
 * data-wikilink-title carries the raw title (without alias) so
 * linkClickHandler can identify the link target without re-parsing the doc.
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
 * The exported CM6 extension. Slot into MarkdownEditor's extensions array
 * alongside livePreviewPlugin and frontmatterPlugin.
 *
 * Update strategy:
 *   - IME composing → map existing decorations (no rebuild)
 *   - docChanged, viewportChanged, or syntax-tree change → full rebuild
 *
 * Resolved-state refresh: decorations rebuild on the NEXT doc/viewport update
 * after setResolvedTitlesSnapshot is called. An explicit resolvedTitlesChanged
 * StateEffect can force an immediate rebuild without a doc change.
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
