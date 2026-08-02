/**
 * livePreviewPlugin — CM6 decoration plugin for live preview of markdown.
 * Walks the lezer-markdown syntax tree on every relevant transaction,
 * computes the cursor-line set (multi-line selection included), and
 * emits per-node decorations:
 *
 *   - Decoration.line for headings (cm-heading-1..6), blockquote
 *     (cm-blockquote), callouts (cm-callout cm-callout-{type}, READ-02),
 *     and code blocks (cm-codeblock).
 *   - Decoration.mark for StrongEmphasis (cm-strong), Emphasis
 *     (cm-emphasis), InlineCode (cm-inline-code), Highlight (cm-highlight,
 *     from the hand-rolled highlightExtension.ts's == delimiter).
 *   - Decoration.replace for hideable marker nodes when their line is
 *     off-cursor (HeaderMark, EmphasisMark, QuoteMark, ListMark, LinkMark,
 *     URL, HardBreak, CodeMark, HighlightMark) and for HorizontalRule
 *     (hr widget), and for a callout's title-line marker+title span
 *     (CalloutTitleWidget, READ-02).
 *   - Decoration.mark with cm-marker for the same hideable nodes when
 *     their line is on-cursor (markers visible-but-muted).
 *
 * Callout detection (READ-02): a Blockquote's first
 * line is checked for a `[!type]` or `[!type]-` prefix (regex, not a lezer
 * node — CommonMark has no callout grammar). A match replaces the plain
 * `.cm-blockquote` line treatment with `cm-callout cm-callout-{type}` for
 * every line in the blockquote's range; no match falls through to the
 * existing plain-blockquote path UNCHANGED (non-regression by construction).
 * The dot is pure CSS (`::before` on `.cm-callout-title-line`, always
 * visible); only the `[!type](-)?\s*title?` span hides/reveals per cursor,
 * exactly like the other hideable markers.
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
import { isCalloutFolded, toggleCalloutFold } from "./calloutFoldField";


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
  "HighlightMark", // == (reuses the on/off-cursor-line reveal logic verbatim)
]);

export const STRONG_MARK_CLASS = "cm-strong";
export const EM_MARK_CLASS = "cm-emphasis";
export const HIGHLIGHT_MARK_CLASS = "cm-highlight";
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


/**
 * CALLOUT_TYPES — the six named callout types with dedicated CSS color
 * treatment (theme.css). Any other `[!word]` value falls back to the
 * "note" style, but keeps its own word as the title.
 */
export const CALLOUT_TYPES = new Set([
  "tip",
  "note",
  "info",
  "warning",
  "danger",
  "todo",
]);

/** Regex for the marker portion of a callout's first line, after stripping the "> " quote prefix. */
const CALLOUT_MARKER_RE = /^\[!(\w+)\](-)?\s*(.*)$/;

/** Capitalizes the first character only (the auto-title rule). */
function capitalizeWord(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const CALLOUT_LINE_CLASS = "cm-callout";
export const CALLOUT_TITLE_LINE_CLASS = "cm-callout-title-line";
export const CALLOUT_TITLE_WIDGET_CLASS = "cm-callout-title-widget";
export const CALLOUT_FOLD_CHEVRON_CLASS = "cm-callout-fold-chevron";

/**
 * makeChevronSvg — builds a ChevronRight (collapsed) / ChevronDown (expanded)
 * SVG via createElementNS (no lucide-react import — CM6 widgets produce
 * plain DOM, not a React render tree). Path data extracted from
 * lucide-react v0.460.0 (chevron-right.js / chevron-down.js), same
 * precedent as taskCheckboxPlugin.ts's makeLucideSvg.
 */
function makeChevronSvg(expanded: boolean): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", expanded ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6");
  svg.appendChild(path);
  return svg;
}

/**
 * CalloutTitleWidget — replaces a callout's first-line `[!type](-)?\s*title?`
 * span (off-cursor only) with the synthesized title text (+ fold chevron for
 * foldable callouts). The colored dot is NOT part of this widget — it
 * is a pure-CSS `::before` on the title line's class so it stays rendered
 * even while the cursor is on that line and the raw markers are revealed
 * revealed.
 */
export class CalloutTitleWidget extends WidgetType {
  constructor(
    public readonly title: string,
    public readonly cssType: string,
    public readonly foldable: boolean = false,
    public readonly folded: boolean = false,
    public readonly blockquoteFrom: number = -1,
  ) {
    super();
  }

  eq(other: CalloutTitleWidget): boolean {
    return (
      other.title === this.title &&
      other.cssType === this.cssType &&
      other.foldable === this.foldable &&
      other.folded === this.folded &&
      other.blockquoteFrom === this.blockquoteFrom
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `${CALLOUT_TITLE_WIDGET_CLASS} cm-callout-title-${this.cssType}`;

    if (this.foldable) {
      const chevron = document.createElement("span");
      chevron.className = CALLOUT_FOLD_CHEVRON_CLASS;
      chevron.setAttribute("role", "button");
      chevron.setAttribute("tabIndex", "-1");
      chevron.setAttribute("data-pos", String(this.blockquoteFrom));
      chevron.setAttribute(
        "aria-label",
        this.folded ? `Expand "${this.title}" callout` : `Collapse "${this.title}" callout`,
      );
      chevron.appendChild(makeChevronSvg(!this.folded));
      span.appendChild(chevron);
    }

    const titleText = document.createElement("span");
    titleText.textContent = this.title;
    span.appendChild(titleText);

    return span;
  }

  ignoreEvent(): boolean {
    return false; // CRITICAL — let clicks reach eventHandlers (mirrors taskCheckboxPlugin's CheckboxWidget)
  }
}


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

        if (node.name === "Blockquote") {
          const firstLine = view.state.doc.lineAt(node.from);
          const markerMatch = firstLine.text.match(/^(>\s?)/);
          const markerLen = markerMatch ? markerMatch[1].length : 0;
          const afterMarker = firstLine.text.slice(markerLen);
          const calloutMatch = afterMarker.match(CALLOUT_MARKER_RE);

          if (calloutMatch) {
            const rawType = calloutMatch[1].toLowerCase();
            const foldable = calloutMatch[2] === "-";
            const explicitTitle = calloutMatch[3].trim();
            const cssType = CALLOUT_TYPES.has(rawType) ? rawType : "note";
            const title = explicitTitle.length > 0 ? explicitTitle : capitalizeWord(rawType);

            let pos = node.from;
            let lineIndex = 0;
            while (pos < node.to) {
              const line = view.state.doc.lineAt(pos);
              const isTitleLine = lineIndex === 0;
              const cls = isTitleLine
                ? `${CALLOUT_LINE_CLASS} cm-callout-${cssType} ${CALLOUT_TITLE_LINE_CLASS}`
                : `${CALLOUT_LINE_CLASS} cm-callout-${cssType}`;
              lineDecos.push({ from: line.from, deco: Decoration.line({ class: cls }) });

              // Manually replicate the QuoteMark hide/reveal that the
              // generic HIDEABLE_MARKER_NODES walk would otherwise provide —
              // descent into this Blockquote's children is stopped below
              // (Link/LinkMark collision guard), so every line's "> " prefix
              // needs its own hide-off-cursor / reveal-on-cursor decoration.
              const lineMarkerMatch = line.text.match(/^(>\s?)/);
              const lineMarkerLen = lineMarkerMatch ? lineMarkerMatch[1].length : 0;
              if (lineMarkerLen > 0) {
                const onQuoteCursorLine = cursorLines.has(line.number);
                markDecos.push({
                  from: line.from,
                  to: line.from + lineMarkerLen,
                  deco: onQuoteCursorLine
                    ? Decoration.mark({ class: VISIBLE_MARKER_CLASS })
                    : Decoration.replace({}),
                  sortKey: line.from * 1e9 + (1e9 - lineMarkerLen),
                });
              }

              if (line.to >= node.to) break;
              pos = line.to + 1;
              lineIndex++;
            }

            const markerFrom = firstLine.from + markerLen;
            const markerTo = firstLine.to;
            if (markerFrom < markerTo) {
              const onCursorLine = cursorLines.has(firstLine.number);
              if (onCursorLine) {
                markDecos.push({
                  from: markerFrom,
                  to: markerTo,
                  deco: Decoration.mark({ class: VISIBLE_MARKER_CLASS }),
                  sortKey: markerFrom * 1e9 + (1e9 - (markerTo - markerFrom)),
                });
              } else {
                const folded = isCalloutFolded(view.state, node.from);
                markDecos.push({
                  from: markerFrom,
                  to: markerTo,
                  deco: Decoration.replace({
                    widget: new CalloutTitleWidget(title, cssType, foldable, folded, node.from),
                  }),
                  sortKey: markerFrom * 1e9 + (1e9 - (markerTo - markerFrom)),
                });
              }
            }

            // Stop descent: lezer parses "[!type]" as shortcut-link-like
            // bracket syntax (Link/LinkMark nodes) that would otherwise
            // double-decorate the exact same range we just handled above.
            // Callout body lines forgo generic inline-formatting decoration
            // as a result — a documented trade-off, not a regression (plain
            // blockquotes below are unaffected and keep full inline support).
            return false;
          }

          // No [!type] match — plain blockquote, unchanged existing behavior.
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

        if (node.name === "Highlight") {
          markDecos.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: HIGHLIGHT_MARK_CLASS, inclusive: true }),
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
          // Coexistence guard: cursor-state-aware coordination with taskCheckboxPlugin.
          if (node.node.parent?.getChild("Task")) {
            // Task line: taskCheckboxPlugin owns only "[ ]" (TaskMarker),
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
      // Callout fold toggles (READ-02) don't touch the doc, viewport,
      // selection, or syntax tree — rebuild explicitly so the chevron
      // direction and folded body decoration stay in sync with
      // calloutFoldField's own StateField.
      const foldToggled = u.transactions.some((tr) =>
        tr.effects.some((e) => e.is(toggleCalloutFold)),
      );
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        foldToggled ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      click(e: MouseEvent, view: EditorView) {
        const target = e.target as HTMLElement | null;
        const chevron = target?.closest(`.${CALLOUT_FOLD_CHEVRON_CLASS}`) as HTMLElement | null;
        if (!chevron) return false;
        const pos = parseInt(chevron.getAttribute("data-pos") ?? "", 10);
        if (isNaN(pos)) return false;
        view.dispatch({ effects: toggleCalloutFold.of({ from: pos }) });
        return true;
      },
    },
  }
);
