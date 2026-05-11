/**
 * wikilinkPlugin — CM6 ViewPlugin that decorates [[Title]] and [[Title|Alias]]
 * wikilinks as clickable styled spans.
 *
 * Design decisions:
 *
 *   - Uses MatchDecorator (from @codemirror/view) with a global regex.
 *     lezer-markdown has NO WikiLink node (RESEARCH.md critical finding), so
 *     syntax-tree iteration is not an option. MatchDecorator operates on line
 *     text and calls the decorate callback for each regex match in the
 *     visible viewport.
 *
 *   - Decoration.replace is used (NOT Decoration.mark) so off-cursor aliases
 *     render correctly: [[Title|Alias]] shows only "Alias" as the link text
 *     (D-17). A Decoration.mark on the full [[...]] span would still show the
 *     raw brackets and pipe. The WikiLinkWidget.toDOM() produces the visible span.
 *
 *   - Pitfall 1 (from RESEARCH.md): WidgetType.ignoreEvent must return false
 *     so click events propagate to the linkClickHandler. If ignoreEvent returns
 *     true, CM6 consumes the event before it reaches our handler.
 *
 *   - D-19 code-context guard: isInsideCodeOrFrontmatter walks the syntax tree
 *     at the match position. If the position is inside FencedCode, CodeBlock,
 *     InlineCode, or Frontmatter, the match is skipped — no decoration emitted.
 *
 *   - IME gate: u.view.composing → map existing decorations through u.changes
 *     instead of rebuilding (same pattern as livePreviewPlugin / frontmatterPlugin).
 *
 *   - Resolved-vs-pending distinction: reads getResolvedTitlesSnapshot() from
 *     wikilinkResolver. MarkdownEditor calls setResolvedTitlesSnapshot in a
 *     useEffect whenever useResolvedTitleSet returns a new Set. The snapshot
 *     refresh triggers on the NEXT doc/viewport update (document that in tests
 *     P11 — the caveat is expected and documented).
 *
 *   - On-cursor line: raw [[Title]] markup stays visible for editing (D-17
 *     live-preview pattern). The cursor-line check uses the single-line
 *     computeCursorLines set; any line containing a selection range is in scope.
 *
 * CSS classes (added to index.css — see Task 2):
 *   .cm-wiki-link                     — resolved link (accent color + underline)
 *   .cm-wiki-link-pending             — pending link (dashed underline + dimmed)
 *   .cm-editor[data-cmd-held] ...     — pointer cursor while Cmd/Ctrl held (D-16)
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

// ---------------------------------------------------------------------------
// StateEffect — resolved-titles refresh signal
// ---------------------------------------------------------------------------

/**
 * Dispatching this effect tells the wikilinkPlugin to do a full
 * createDeco() rebuild on the next update cycle. MarkdownEditor fires it
 * from the useEffect that updates the module-level snapshot whenever
 * useResolvedTitleSet() returns a new Set.
 *
 * Why an effect instead of relying on selectionSet / docChanged:
 *   MatchDecorator.updateDeco() only rebuilds when the doc or viewport
 *   changed — a pure selection dispatch is silently ignored by updateDeco.
 *   Detecting the effect in the plugin's update() and calling createDeco()
 *   directly (full rebuild) is the correct CM6 pattern for external state
 *   changes that affect decorations.
 */
export const resolvedTitlesChanged = StateEffect.define<void>();

// ---------------------------------------------------------------------------
// Regex
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// WikiLinkWidget — WidgetType subclass (Pitfall 1: must use toDOM)
// ---------------------------------------------------------------------------

/**
 * Renders the visible [[Title]] / [[Title|Alias]] replacement.
 * Off-cursor: the raw [[...]] markup is replaced by this widget's span.
 * On-cursor line: NO replace decoration is emitted (raw markup visible).
 *
 * Security (T-06-09-01): textContent is used, NEVER innerHTML. The
 * displayText is user-controlled (wikilink title) but setting it via
 * textContent means no HTML parsing — XSS impossible through this path.
 *
 * data-wikilink-title carries the raw title (without alias) so linkClickHandler
 * can identify the link target on click without re-parsing the doc text.
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
    // textContent NOT innerHTML — T-06-09-01 XSS mitigation
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
   * Pitfall 1: return false so click events bubble to the editor's DOM
   * event handlers and reach linkClickHandler. If this returned true,
   * CM6 would consume clicks before our handler sees them.
   */
  ignoreEvent(): boolean {
    return false;
  }
}

// ---------------------------------------------------------------------------
// D-19 code-context guard
// ---------------------------------------------------------------------------

/**
 * Returns true if the position is inside any code or frontmatter context
 * that should suppress wiki-link decoration (D-19).
 *
 * Walks the parent chain from the innermost node at `pos`. Any of these
 * node types in the ancestor chain suppresses the decoration:
 *   FencedCode   — fenced ``` block
 *   CodeBlock    — indented code block
 *   InlineCode   — `` `code` `` span
 *   Frontmatter  — YAML front-matter block (any key, not just tags)
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

// ---------------------------------------------------------------------------
// Cursor-line set helper (mirror of livePreviewPlugin.computeCursorLines)
// ---------------------------------------------------------------------------

function computeCursorLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const startLine = view.state.doc.lineAt(range.from).number;
    const endLine = view.state.doc.lineAt(range.to).number;
    for (let n = startLine; n <= endLine; n++) lines.add(n);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// MatchDecorator instance
// ---------------------------------------------------------------------------

const wikilinkMatcher = new MatchDecorator({
  regexp: WIKILINK_RE,
  decorate(add, from, to, match, view) {
    // D-19: skip matches inside code / frontmatter context
    if (isInsideCodeOrFrontmatter(view, from)) return;

    // On-cursor line: skip — leave raw [[...]] markup visible for editing
    const cursorLines = computeCursorLines(view);
    const lineNum = view.state.doc.lineAt(from).number;
    if (cursorLines.has(lineNum)) return;

    const rawTitle = match[1];
    const alias = match[2];
    const displayText = alias ?? rawTitle;

    // Read the module-level snapshot from wikilinkResolver.
    // MarkdownEditor keeps this up to date via useEffect.
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

// ---------------------------------------------------------------------------
// ViewPlugin
// ---------------------------------------------------------------------------

/**
 * The exported CM6 extension. Slot this into MarkdownEditor's extensions
 * array alongside livePreviewPlugin and frontmatterPlugin.
 *
 * Update strategy:
 *   - IME composing → map existing decorations (no rebuild)
 *   - docChanged, viewportChanged, or syntax-tree change → full rebuild
 *
 * Resolved-state refresh: after setResolvedTitlesSnapshot is called,
 * decorations are rebuilt on the NEXT doc/viewport update. A future
 * improvement could dispatch an explicit StateEffect to force an immediate
 * rebuild without requiring a doc change (documented here for Plan 06-11).
 */
export const wikilinkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = wikilinkMatcher.createDeco(view);
    }

    update(u: ViewUpdate) {
      if (u.view.composing) {
        // IME gate — D-07/D-31 pattern: map existing decorations through
        // document changes to keep positions valid without a full rebuild.
        this.decorations = this.decorations.map(u.changes);
        return;
      }
      // Full rebuild when the resolved-titles snapshot changed (external
      // state — MatchDecorator.updateDeco won't catch it on selection-only
      // dispatches). createDeco rebuilds all visible decorations from scratch.
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
