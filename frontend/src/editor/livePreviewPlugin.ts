/**
 * livePreviewPlugin — Phase 5 production decoration plugin (D-01..D-09).
 * Walks the lezer-markdown syntax tree on every relevant transaction,
 * computes the cursor-line set (multi-line selection per D-06), and
 * emits per-node decorations:
 *
 *   - Decoration.line for headings (cm-heading-1..6 — EDIT-02),
 *     blockquote (cm-blockquote — EDIT-05), and code blocks
 *     (cm-codeblock — D-02 visual).
 *   - Decoration.mark for StrongEmphasis (cm-strong — EDIT-03),
 *     Emphasis (cm-emphasis — EDIT-03), InlineCode (cm-inline-code
 *     — EDIT-06).
 *   - Decoration.replace for HIDEABLE marker nodes when their line
 *     is OFF-cursor (HeaderMark, EmphasisMark, QuoteMark, ListMark,
 *     LinkMark, URL, HardBreak, CodeMark — D-01) AND for HorizontalRule
 *     via a small <hr> widget (EDIT-07).
 *   - Decoration.mark with class cm-marker for the SAME hideable
 *     nodes when their line IS on-cursor (markers visible-but-muted).
 *
 * Edge cases:
 *   - D-06 Multi-line selection: every line touched by a selection
 *     range stays in the cursor-line set; markers visible there.
 *   - D-07/D-31 IME gate: u.view.composing → skip rebuild; map
 *     existing decorations through u.changes instead.
 *   - D-09 Code-fence guard: any HIDEABLE node nested inside
 *     FencedCode is skipped (markers stay literal). InlineCode's
 *     backticks ARE allowed to hide off-line per UI-SPEC line 323
 *     ("Inline code backticks: Hidden when off-line") — the styled
 *     monospace background carries the affordance.
 *
 * Note for code-fence content: the language-specific grammars (Plan
 * 05-07) are injected via markdown({codeLanguages: [...]}). The
 * plugin's syntax-tree iteration receives FencedCode → CodeText
 * children with whatever the inner language emitted; isInsideCode
 * still trips on the FencedCode parent so emphasis-style markers
 * inside `**not bold**` blocks are NOT hidden.
 *
 * Node names verified by spike (Plan 05-01 findings):
 * - Frontmatter (lowercase m) — NOT "FrontMatter"
 * - ATXHeading1..ATXHeading6, SetextHeading1, SetextHeading2
 * - HeaderMark — `#` markers
 * - StrongEmphasis, Emphasis, EmphasisMark
 * - FencedCode, InlineCode
 * - Blockquote, QuoteMark
 * - ListMark, HorizontalRule
 * - LinkMark, URL
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

// Map from lezer node name → CSS class for heading line decorations.
// Decoration.line is used (not Decoration.mark on the text) to avoid
// cursor-jump artifacts when the heading font-size changes (Pitfall 3).
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

// Production scope (Plan 05-06): extend spike's heading + emphasis
// marks with the SPIKE-FINDINGS recommendation list.
export const HIDEABLE_MARKER_NODES = new Set<string>([
  "HeaderMark",   // # ## ###
  "EmphasisMark", // * _ ** __
  "QuoteMark",    // >
  "ListMark",     // - + 1.
  "LinkMark",     // [ ]
  "URL",          // (href)
  "HardBreak",    // trailing 2-space line break
  "CodeMark",     // ` `` ``` (inline-code backticks; FencedCode guard
                  //   prevents these hiding when nested in FencedCode)
]);

export const STRONG_MARK_CLASS = "cm-strong";
export const EM_MARK_CLASS = "cm-emphasis";
export const VISIBLE_MARKER_CLASS = "cm-marker";

// Block-level line decorations (production extends spike).
export const BLOCKQUOTE_LINE_CLASS = "cm-blockquote";
export const CODEBLOCK_LINE_CLASS = "cm-codeblock";
export const INLINE_CODE_MARK_CLASS = "cm-inline-code";

const blockquoteLineDeco = Decoration.line({ class: BLOCKQUOTE_LINE_CLASS });
const codeblockLineDeco  = Decoration.line({ class: CODEBLOCK_LINE_CLASS });
// inclusive: true → startSide=-1, same as parent span marks (StrongEmphasis,
// Emphasis). Required so InlineCode sorts before its CodeMark children at the
// same `from` position (RangeSetBuilder startSide ordering constraint).
const inlineCodeMarkDeco = Decoration.mark({ class: INLINE_CODE_MARK_CLASS, inclusive: true });

// Block-node → line decoration map. Used by the line-decoration pass
// to emit ONE Decoration.line per line that sits inside a Blockquote
// or FencedCode block. Walk the line range; for each line whose
// resolveInner block parent matches a key in this map, emit the deco.
const BLOCK_LINE_DECOS: Record<string, Decoration> = {
  Blockquote: blockquoteLineDeco,
  FencedCode: codeblockLineDeco,
};

// EDIT-07 — HorizontalRule rendering. Decoration.replace with a tiny
// widget that renders an <hr class="cm-hr">. The themeBridge styles
// .cm-hr (border-color: var(--color-border), vertical margin 16px
// per UI-SPEC §Spacing).
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

/**
 * Compute the set of line numbers that contain the current selection.
 * Multi-line selections (D-06): every line between anchor and head
 * (inclusive) stays in the visible-marker set.
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
 * D-09 amendment: ONLY FencedCode is the no-hide container.
 * Inline code's backticks ARE allowed to hide off-line per UI-SPEC
 * line 323 — the styled monospace background carries the affordance.
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
 * Exported as a pure function for testability (no side effects; depends
 * only on view.state + view.visibleRanges).
 *
 * Two-pass approach: collect entries first (they may arrive out of
 * sort order due to parent-node visiting before children), then sort
 * and feed to RangeSetBuilder which requires ascending order.
 */
export function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const cursorLines = computeCursorLines(view);
  const tree = syntaxTree(view.state);

  // Collect decorations in two separate arrays to avoid RangeSetBuilder
  // ordering conflicts between zero-width line decorations and inline marks:
  //   lineDecos  — Decoration.line entries (zero-width, from===to)
  //   markDecos  — Decoration.mark / Decoration.replace (inline spans)
  //
  // RangeSetBuilder requires strictly sorted input by (from, startSide).
  // Line decorations at position P must be added BEFORE inline marks at P.
  // We guarantee this by sorting lineDecos and markDecos independently and
  // interleaving them with line-before-mark priority.
  const lineDecos: { from: number; deco: Decoration }[] = [];
  const markDecos: Entry[] = [];

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        // --- Heading line decoration (EDIT-02) ---
        // Decoration.line on the cm-line wrapper. CSS targets .cm-line.cm-heading-N.
        const headingClass = HEADING_LINE_CLASSES[node.name];
        if (headingClass !== undefined) {
          const line = view.state.doc.lineAt(node.from);
          lineDecos.push({
            from: line.from,
            deco: Decoration.line({ class: headingClass }),
          });
          // Tree continues into children (HeaderMark) — do NOT return.
          return;
        }

        // --- Block-node line decorations (NEW: Blockquote, FencedCode) ---
        // Apply line-deco to every line in the block's range.
        if (BLOCK_LINE_DECOS[node.name]) {
          const deco = BLOCK_LINE_DECOS[node.name];
          let pos = node.from;
          while (pos < node.to) {
            const line = view.state.doc.lineAt(pos);
            lineDecos.push({ from: line.from, deco });
            if (line.to >= node.to) break;
            pos = line.to + 1;
          }
          // Return false to continue iteration into children (QuoteMark etc.)
          return;
        }

        // --- HorizontalRule (EDIT-07) ---
        if (node.name === "HorizontalRule") {
          markDecos.push({
            from: node.from,
            to: node.to,
            deco: hrDeco,
            sortKey: node.from * 1e9 + (1e9 - (node.to - node.from)),
          });
          return;
        }

        // --- Emphasis span decorations (StrongEmphasis, Emphasis — EDIT-03) ---
        // Mark the full ** ... ** / * ... * span so CSS can style it.
        // inclusive: true sets the mark's startSide to -1, which satisfies
        // RangeSetBuilder's requirement that parent marks (startSide=-1) sort
        // before child marks (startSide=0) when they share the same `from`.
        if (node.name === "StrongEmphasis") {
          markDecos.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: STRONG_MARK_CLASS, inclusive: true }),
            sortKey: node.from * 1e9 + (1e9 - (node.to - node.from)),
          });
          // Fall through: tree continues into EmphasisMark children.
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

        // --- InlineCode (EDIT-06) ---
        // Mark the full `...` span with cm-inline-code.
        // D-09 amendment: InlineCode is NOT a no-hide container for its
        // own CodeMark children — they hide off-line per UI-SPEC line 323.
        // isInsideCode only guards against FencedCode.
        if (node.name === "InlineCode") {
          markDecos.push({
            from: node.from,
            to: node.to,
            deco: inlineCodeMarkDeco,
            sortKey: node.from * 1e9 + (1e9 - (node.to - node.from)),
          });
          // Continue into children (CodeMark nodes) for marker hiding.
          return;
        }

        // --- Hideable marker decoration (extended set — D-01) ---
        // Off-line → Decoration.replace({}) hides the marker character(s).
        // On-line  → Decoration.mark({class:"cm-marker"}) shows them styled.
        // D-09: markers inside FencedCode are NEVER hidden (isInsideCode).
        if (HIDEABLE_MARKER_NODES.has(node.name)) {
          if (isInsideCode(node)) return; // D-09 FencedCode guard
          const lineNum = view.state.doc.lineAt(node.from).number;
          const onCursorLine = cursorLines.has(lineNum);
          markDecos.push({
            from: node.from,
            to: node.to,
            deco: onCursorLine
              ? Decoration.mark({ class: VISIBLE_MARKER_CLASS })
              : Decoration.replace({}),
            // Narrower child markers sort after their wider parents at same pos.
            sortKey: node.from * 1e9 + (1e9 - (node.to - node.from)),
          });
        }
      },
    });
  }

  // Sort each array independently, then interleave: line decos at position P
  // always feed into the builder before inline marks at the same P.
  lineDecos.sort((a, b) => a.from - b.from);
  markDecos.sort((a, b) => a.sortKey - b.sortKey);

  // Merge: consume lineDecos and markDecos in ascending-from order,
  // with line decos taking priority when from values are equal.
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
        // D-07/D-31: do not rebuild during IME composition. Map existing
        // decorations through the document changes to keep positions valid.
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
