/**
 * livePreviewPlugin — CM6 decoration plugin for live preview of markdown.
 * Walks the lezer-markdown syntax tree on every relevant transaction,
 * computes the cursor-line set (multi-line selection included), and
 * emits per-node decorations:
 *
 *   - Decoration.line for headings (cm-heading-1..6), blockquote
 *     (cm-blockquote), and code blocks (cm-codeblock).
 *   - Decoration.mark for StrongEmphasis (cm-strong), Emphasis
 *     (cm-emphasis), InlineCode (cm-inline-code).
 *   - Decoration.replace for hideable marker nodes when their line is
 *     off-cursor (HeaderMark, EmphasisMark, QuoteMark, ListMark, LinkMark,
 *     URL, HardBreak, CodeMark) and for HorizontalRule (hr widget).
 *   - Decoration.mark with cm-marker for the same hideable nodes when
 *     their line is on-cursor (markers visible-but-muted).
 *
 * Edge cases:
 *   - Multi-line selection: every line touched stays in the cursor-line
 *     set; markers remain visible there.
 *   - IME gate: u.view.composing → map existing decorations through
 *     u.changes instead of rebuilding.
 *   - Code-fence guard: any hideable node nested inside FencedCode is
 *     skipped (markers stay literal). InlineCode backticks ARE allowed to
 *     hide off-line — the styled monospace background carries the affordance.
 *
 * lezer-markdown node names used (case-sensitive):
 *   Frontmatter (lowercase m), ATXHeading1..6, SetextHeading1/2,
 *   HeaderMark, StrongEmphasis, Emphasis, EmphasisMark, FencedCode,
 *   InlineCode, Blockquote, QuoteMark, ListMark, HorizontalRule,
 *   LinkMark, URL.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";

import { isExternalLikeUrl } from "./linkUrl";


export const HEADING_LINE_CLASSES: Record<string, string> = {
  ATXHeading1: "cm-heading-1",
  ATXHeading2: "cm-heading-2",
  ATXHeading3: "cm-heading-3",
  ATXHeading4: "cm-heading-4",
  ATXHeading5: "cm-heading-5",
  ATXHeading6: "cm-heading-6",
  SetextHeading1: "cm-heading-1",
  SetextHeading2: "cm-heading-2",
};


export const HIDEABLE_MARKER_NODES = new Set<string>([
  "HeaderMark",   // # ## ###
  "EmphasisMark", // * _ ** __
  "QuoteMark",    // >
  "LinkMark",     // [ ]
  "URL",          // (href)
  "HardBreak",    // trailing 2-space line break
  "CodeMark",     // ` `` ``` (inline-code backticks; FencedCode guard
                  //   prevents these hiding when nested in FencedCode)
]);

export const STRONG_MARK_CLASS = "cm-strong";
export const EM_MARK_CLASS = "cm-emphasis";
export const VISIBLE_MARKER_CLASS = "cm-marker";
export const LINK_MARK_CLASS = "cm-link";
export const EXTERNAL_LINK_MARK_CLASS = "cm-link cm-link-external";


class ExternalLinkIconWidget extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-external-link-icon";
    span.setAttribute("aria-hidden", "true");
    span.textContent = "↗";
    return span;
  }
  eq() {
    return true;
  }
  ignoreEvent() {
    return true;
  }
}
const externalLinkIconDeco = Decoration.widget({
  widget: new ExternalLinkIconWidget(),
  side: 1,
});


export const BLOCKQUOTE_LINE_CLASS = "cm-blockquote";
export const CODEBLOCK_LINE_CLASS = "cm-codeblock";
export const INLINE_CODE_MARK_CLASS = "cm-inline-code";

const blockquoteLineDeco = Decoration.line({ class: BLOCKQUOTE_LINE_CLASS });
const codeblockLineDeco  = Decoration.line({ class: CODEBLOCK_LINE_CLASS });


const inlineCodeMarkDeco = Decoration.mark({ class: INLINE_CODE_MARK_CLASS, inclusive: true });


const BLOCK_LINE_DECOS: Record<string, Decoration> = {
  Blockquote: blockquoteLineDeco,
};


export const CODEBLOCK_FIRST_LINE_CLASS = "cm-codeblock cm-codeblock-first";
export const CODEBLOCK_LAST_LINE_CLASS = "cm-codeblock cm-codeblock-last";
export const CODEBLOCK_BOTH_LINE_CLASS =
  "cm-codeblock cm-codeblock-first cm-codeblock-last";
const codeblockMidLineDeco = codeblockLineDeco;
const codeblockFirstLineDeco = Decoration.line({
  class: CODEBLOCK_FIRST_LINE_CLASS,
});
const codeblockLastLineDeco = Decoration.line({
  class: CODEBLOCK_LAST_LINE_CLASS,
});
const codeblockBothLineDeco = Decoration.line({
  class: CODEBLOCK_BOTH_LINE_CLASS,
});


class HRWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement("hr");
    hr.className = "cm-hr";
    hr.setAttribute("aria-hidden", "true");
    return hr;
  }
  eq() { return true; }
  ignoreEvent() { return true; }
}
const hrDeco = Decoration.replace({ widget: new HRWidget() });


class BulletWidget extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-list-bullet";
    span.setAttribute("aria-hidden", "true");
    span.textContent = "•";
    return span;
  }
  eq() { return true; }
  ignoreEvent() { return true; }
}
const bulletDeco = Decoration.replace({ widget: new BulletWidget() });

/**
 * Compute the set of line numbers that contain the current selection.
 * For multi-line selections, every line between anchor and head (inclusive)
 * stays in the visible-marker set.
 */
export function computeCursorLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const startLine = view.state.doc.lineAt(range.from).number;
    const endLine = view.state.doc.lineAt(range.to).number;
    for (let n = startLine; n <= endLine; n++) lines.add(n);
  }
  return lines;
}

/**
 * Walk the parent chain of a syntax node to detect fenced code context.
 * Only FencedCode suppresses hiding; inline code backticks may still hide
 * off-line because the monospace background carries the affordance.
 */
function isInsideCode(node: SyntaxNodeRef): boolean {
  let p = node.node.parent;
  while (p) {
    if (p.name === "FencedCode") return true;
    p = p.parent;
  }
  return false;
}

type Entry = { from: number; to: number; deco: Decoration; sortKey: number };

/**
 * Build the full decoration set for the current view state.
 * Exported as a pure function for testability.
 *
 * Two-pass: collect entries first (parent-node visiting before children
 * can produce out-of-order positions), then sort and feed to
 * RangeSetBuilder which requires ascending order.
 */
export function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const cursorLines = computeCursorLines(view);
  const tree = syntaxTree(view.state);

  const lineDecos: { from: number; deco: Decoration }[] = [];
  const markDecos: Entry[] = [];

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        const headingClass = HEADING_LINE_CLASSES[node.name];
        if (headingClass !== undefined) {
          const line = view.state.doc.lineAt(node.from);
          lineDecos.push({
            from: line.from,
            deco: Decoration.line({ class: headingClass }),
          });
          return;
        }

        if (BLOCK_LINE_DECOS[node.name]) {
          const deco = BLOCK_LINE_DECOS[node.name];
          let pos = node.from;
          while (pos < node.to) {
            const line = view.state.doc.lineAt(pos);
            lineDecos.push({ from: line.from, deco });
            if (line.to >= node.to) break;
            pos = line.to + 1;
          }
          return;
        }

        if (node.name === "FencedCode") {
          const lineStarts: number[] = [];
          let pos = node.from;
          while (pos < node.to) {
            const line = view.state.doc.lineAt(pos);
            lineStarts.push(line.from);
            if (line.to >= node.to) break;
            pos = line.to + 1;
          }
          for (let i = 0; i < lineStarts.length; i++) {
            const isFirst = i === 0;
            const isLast = i === lineStarts.length - 1;
            const deco =
              isFirst && isLast
                ? codeblockBothLineDeco
                : isFirst
                  ? codeblockFirstLineDeco
                  : isLast
                    ? codeblockLastLineDeco
                    : codeblockMidLineDeco;
            lineDecos.push({ from: lineStarts[i], deco });
          }
          return;
        }

        if (node.name === "HorizontalRule") {
          markDecos.push({
            from: node.from,
            to: node.to,
            deco: hrDeco,
            sortKey: node.from * 1e9 + (1e9 - (node.to - node.from)),
          });
          return;
        }

        if (node.name === "StrongEmphasis") {
          markDecos.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: STRONG_MARK_CLASS, inclusive: true }),
            sortKey: node.from * 1e9 + (1e9 - (node.to - node.from)),
          });
          return;
        }
        if (node.name === "Emphasis") {
          markDecos.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: EM_MARK_CLASS, inclusive: true }),
            sortKey: node.from * 1e9 + (1e9 - (node.to - node.from)),
          });
          return;
        }

        if (node.name === "Link") {
          let urlText = "";
          let closeBracketTo = -1;
          let linkMarkCount = 0;
          const c = node.node.cursor();
          if (c.firstChild()) {
            do {
              if (c.name === "LinkMark") {
                linkMarkCount++;
                if (linkMarkCount === 2) closeBracketTo = c.to;
              } else if (c.name === "URL") {
                urlText = view.state.doc.sliceString(c.from, c.to);
              }
            } while (c.nextSibling());
          }
          const isExternal = isExternalLikeUrl(urlText);
          markDecos.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({
              class: isExternal ? EXTERNAL_LINK_MARK_CLASS : LINK_MARK_CLASS,
              inclusive: true,
            }),
            sortKey: node.from * 1e9 + (1e9 - (node.to - node.from)),
          });
          if (isExternal && closeBracketTo > 0) {
            markDecos.push({
              from: closeBracketTo,
              to: closeBracketTo,
              deco: externalLinkIconDeco,
              sortKey: closeBracketTo * 1e9 + 1,
            });
          }
          return;
        }

        if (node.name === "InlineCode") {
          markDecos.push({
            from: node.from,
            to: node.to,
            deco: inlineCodeMarkDeco,
            sortKey: node.from * 1e9 + (1e9 - (node.to - node.from)),
          });
          return;
        }

        if (node.name === "ListMark") {
          if (isInsideCode(node)) return;
          // Coexistence guard (D-02 reversed): cursor-state-aware coordination with taskCheckboxPlugin.
          if (node.node.parent?.getChild("Task")) {
            // Task line: D-02 is REVERSED — taskCheckboxPlugin now owns only "[ ]" (TaskMarker),
            // NOT the full "- [ ] " prefix. livePreviewPlugin therefore handles the ListMark "-"
            // identically to a regular list item:
            //   Off-cursor: render bullet widget (•) replacing the "-"
            //   On-cursor: render .cm-marker so the raw "-" is muted-but-visible
            const lineNum = view.state.doc.lineAt(node.from).number;
            const text = view.state.doc.sliceString(node.from, node.to).trim();
            const isUnordered = /^[-*+]$/.test(text);
            if (!isUnordered) return; // ordered-list task marker stays as-is
            markDecos.push({
              from: node.from,
              to: node.to,
              deco: cursorLines.has(lineNum)
                ? Decoration.mark({ class: `${VISIBLE_MARKER_CLASS} cm-list-marker` })
                : bulletDeco,
              sortKey: node.from * 1e9 + (1e9 - (node.to - node.from)),
            });
            return;
          }
          const text = view.state.doc.sliceString(node.from, node.to).trim();
          const isUnordered = /^[-*+]$/.test(text);
          if (!isUnordered) return;
          const lineNum = view.state.doc.lineAt(node.from).number;
          const onCursorLine = cursorLines.has(lineNum);
          markDecos.push({
            from: node.from,
            to: node.to,
            deco: onCursorLine
              ? Decoration.mark({ class: `${VISIBLE_MARKER_CLASS} cm-list-marker` })
              : bulletDeco,
            sortKey: node.from * 1e9 + (1e9 - (node.to - node.from)),
          });
          return;
        }

        if (HIDEABLE_MARKER_NODES.has(node.name)) {
          if (isInsideCode(node)) return;
          const lineNum = view.state.doc.lineAt(node.from).number;
          const onCursorLine = cursorLines.has(lineNum);
          if (onCursorLine) {
            markDecos.push({
              from: node.from,
              to: node.to,
              deco: Decoration.mark({ class: VISIBLE_MARKER_CLASS }),
              sortKey: node.from * 1e9 + (1e9 - (node.to - node.from)),
            });
            return;
          }

          let to = node.to;
          if (node.name === "HeaderMark") {
            const nextChar = view.state.doc.sliceString(node.to, node.to + 1);
            if (nextChar === " ") to = node.to + 1;
          }
          markDecos.push({
            from: node.from,
            to,
            deco: Decoration.replace({}),
            sortKey: node.from * 1e9 + (1e9 - (node.to - node.from)),
          });
        }
      },
    });
  }

  lineDecos.sort((a, b) => a.from - b.from);
  markDecos.sort((a, b) => a.sortKey - b.sortKey);

  let li = 0;
  let mi = 0;
  while (li < lineDecos.length || mi < markDecos.length) {
    const nextLine = li < lineDecos.length ? lineDecos[li] : null;
    const nextMark = mi < markDecos.length ? markDecos[mi] : null;
    if (nextLine && (!nextMark || nextLine.from <= nextMark.from)) {
      builder.add(nextLine.from, nextLine.from, nextLine.deco);
      li++;
    } else if (nextMark) {
      builder.add(nextMark.from, nextMark.to, nextMark.deco);
      mi++;
    }
  }

  return builder.finish();
}

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.view.composing) {
        this.decorations = this.decorations.map(u.changes);
        return;
      }
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);
