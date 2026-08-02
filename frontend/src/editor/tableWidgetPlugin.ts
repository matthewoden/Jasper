/**
 * tableWidgetPlugin renders GFM tables as real <table> widgets (READ-04).
 *
 * Block decorations must come from a StateField, not a ViewPlugin — a CM6
 * constraint.
 *
 * Cursor model is the OPPOSITE of callouts: the cursor entering any line of the
 * table drops the WHOLE block to raw markdown, not just that line. So the field
 * must rebuild on selection changes too, not only docChanged.
 *
 * Cell content is rebuilt with createElement/textContent only — never a
 * raw-HTML string.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { StateField, RangeSetBuilder } from "@codemirror/state";
import type { EditorState, Transaction, Extension, Text } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

import { computeCursorLines } from "./livePreviewPlugin";
import { isExternalLikeUrl, ensureProtocol } from "./linkUrl";


export const TABLE_SCROLL_CLASS = "cm-table-scroll";
export const TABLE_CLASS = "cm-table";
export const TABLE_FALLBACK_CLASS = "cm-table-fallback";


/** Appends a plain text run (no element wrapper) if non-empty. */
function appendTextRun(container: HTMLElement, text: string): void {
  if (text.length === 0) return;
  container.appendChild(document.createTextNode(text));
}

/**
 * Renders a single recognized inline lezer node into `container`. Anything
 * not explicitly handled falls through to a plain text run of its slice —
 * built via createElement/textContent only, never a raw-HTML-string assign.
 */
function renderInlineNode(node: SyntaxNode, doc: Text, container: HTMLElement): void {
  switch (node.name) {
    case "StrongEmphasis": {
      const strong = document.createElement("strong");
      renderInlineChildren(node, doc, strong, "EmphasisMark");
      container.appendChild(strong);
      return;
    }
    case "Emphasis": {
      const em = document.createElement("em");
      renderInlineChildren(node, doc, em, "EmphasisMark");
      container.appendChild(em);
      return;
    }
    case "Highlight": {
      const mark = document.createElement("mark");
      renderInlineChildren(node, doc, mark, "HighlightMark");
      container.appendChild(mark);
      return;
    }
    case "InlineCode": {
      const code = document.createElement("code");
      const marks = node.getChildren("CodeMark");
      const inner =
        marks.length >= 2
          ? doc.sliceString(marks[0].to, marks[marks.length - 1].from)
          : doc.sliceString(node.from, node.to);
      code.textContent = inner;
      container.appendChild(code);
      return;
    }
    case "Link": {
      const marks = node.getChildren("LinkMark");
      const urlNode = node.getChild("URL");
      const text =
        marks.length >= 2
          ? doc.sliceString(marks[0].to, marks[1].from)
          : doc.sliceString(node.from, node.to);
      // Only emit a live href for external-like URLs (http(s)/bare-domain).
      // Anything else — javascript:/data:/relative/wiki — renders as inert
      // styled text, matching the editor's zero-attack-surface link model
      // (livePreviewPlugin never sets href; navigation is cmd-click gated).
      const rawUrl = urlNode ? doc.sliceString(urlNode.from, urlNode.to).trim() : "";
      const a = document.createElement("a");
      a.textContent = text;
      if (rawUrl && isExternalLikeUrl(rawUrl)) {
        a.setAttribute("href", ensureProtocol(rawUrl));
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
      container.appendChild(a);
      return;
    }
    default:
      appendTextRun(container, doc.sliceString(node.from, node.to));
  }
}

/**
 * Walks `node`'s direct children, rendering each recognized inline node and
 * filling gaps with plain text runs. `skipMarkName` (e.g. "EmphasisMark")
 * strips the delimiter-mark children of an already-recognized wrapper node
 * (StrongEmphasis/Emphasis/Highlight) so the rendered text excludes `**`/`==`.
 */
function renderInlineChildren(
  node: SyntaxNode,
  doc: Text,
  container: HTMLElement,
  skipMarkName?: string,
): void {
  let pos = node.from;
  const cursor = node.cursor();
  if (cursor.firstChild()) {
    do {
      // Flush the gap BEFORE deciding what this child is — a skip-mark's
      // preceding gap (e.g. the "bold" text between the two "**" marks)
      // must not be dropped just because the current child is a marker.
      if (cursor.from > pos) {
        appendTextRun(container, doc.sliceString(pos, cursor.from));
      }
      if (skipMarkName && cursor.name === skipMarkName) {
        pos = cursor.to;
        continue;
      }
      renderInlineNode(cursor.node, doc, container);
      pos = cursor.to;
    } while (cursor.nextSibling());
  }
  if (node.to > pos) {
    appendTextRun(container, doc.sliceString(pos, node.to));
  }
}

/** Renders a TableCell's inline content into a <th>/<td>. */
function renderCellContent(cellNode: SyntaxNode, doc: Text, container: HTMLElement): void {
  renderInlineChildren(cellNode, doc, container);
}


/**
 * TableWidget — replaces an entire GFM `Table` node's range with a real
 * `<table>` element wrapped in a horizontally-scrollable container —
 * the 760px column never widens, the table scrolls inside it instead).
 */
export class TableWidget extends WidgetType {
  constructor(
    private readonly node: SyntaxNode,
    private readonly doc: Text,
    private readonly rawText: string,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return this.rawText === other.rawText;
  }

  toDOM(): HTMLElement {
    try {
      return this.build();
    } catch {
      return this.fallback();
    }
  }

  /** Fail-soft: renders the raw markdown text, no user-facing error. */
  private fallback(): HTMLElement {
    const div = document.createElement("div");
    div.className = TABLE_FALLBACK_CLASS;
    div.textContent = this.rawText;
    return div;
  }

  private build(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = TABLE_SCROLL_CLASS;

    const table = document.createElement("table");
    table.className = TABLE_CLASS;

    const headerNode = this.node.getChild("TableHeader");
    if (headerNode) {
      const thead = document.createElement("thead");
      const tr = document.createElement("tr");
      for (const cell of headerNode.getChildren("TableCell")) {
        const th = document.createElement("th");
        renderCellContent(cell, this.doc, th);
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      table.appendChild(thead);
    }

    const tbody = document.createElement("tbody");
    for (const row of this.node.getChildren("TableRow")) {
      const tr = document.createElement("tr");
      for (const cell of row.getChildren("TableCell")) {
        const td = document.createElement("td");
        renderCellContent(cell, this.doc, td);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    wrapper.appendChild(table);
    return wrapper;
  }

  ignoreEvent(): boolean {
    // false = let CM6's default click handling run (maps the click to a
    // document position at the widget's boundary), which is what drops the
    // block to raw markdown on cursor entry. Unlike the small
    // decorative widgets (HRWidget/BulletWidget), this widget has no
    // adjacent real DOM within its bounds for a native browser caret to
    // land on, so CM's own position mapping must run.
    return false;
  }
}


/** Reads the cursor-occupied line set for a plain EditorState (no EditorView available inside a StateField). */
function cursorLinesForState(state: EditorState): Set<number> {
  return computeCursorLines({ state } as unknown as EditorView);
}

/**
 * buildTableDecorations — exported for testing. Walks every `Table` node;
 * emits a block-replace widget decoration UNLESS the cursor occupies any of
 * the table's lines, in which case nothing is emitted (raw markdown stays
 * visible).
 */
export function buildTableDecorations(
  state: EditorState,
  cursorLines: Set<number>,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(state);
  const doc = state.doc;

  tree.iterate({
    enter(node) {
      if (node.name !== "Table") return;

      const fromLine = doc.lineAt(node.from).number;
      const toLine = doc.lineAt(node.to).number;
      let cursorInside = false;
      for (let n = fromLine; n <= toLine; n++) {
        if (cursorLines.has(n)) {
          cursorInside = true;
          break;
        }
      }
      if (cursorInside) return; // raw markdown — no widget

      const widget = new TableWidget(node.node, doc, doc.sliceString(node.from, node.to));
      builder.add(node.from, node.to, Decoration.replace({ widget, block: true }));
    },
  });

  return builder.finish();
}

/**
 * tableDecoField — StateField holding the table DecorationSet. Rebuilds on
 * both doc changes AND selection changes (cursor movement alone must flip
 * widget<->raw) — wider trigger set than frontmatterHidePlugin's doc-only
 * rebuild.
 */
const tableDecoField = StateField.define<DecorationSet>({
  create(state) {
    return buildTableDecorations(state, cursorLinesForState(state));
  },
  update(prev, tr: Transaction) {
    const selectionChanged = !tr.startState.selection.eq(tr.state.selection);
    if (tr.docChanged || selectionChanged) {
      return buildTableDecorations(tr.state, cursorLinesForState(tr.state));
    }
    return prev.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** tableWidgetExtension — full extension set for MarkdownEditor. */
export const tableWidgetExtension: Extension = [tableDecoField];

/** Exported for tableWidgetPlugin.test.ts's direct StateField introspection. */
export { tableDecoField };
