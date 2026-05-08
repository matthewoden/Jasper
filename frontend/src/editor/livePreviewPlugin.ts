/**
 * livePreviewPlugin — Phase 5 spike (D-05). Walks the lezer-markdown
 * syntax tree on every relevant transaction, computes the cursor-
 * line set (multi-line selection per D-06), and emits Decoration.line
 * for headings + Decoration.mark/replace for EmphasisMark.
 *
 * SPIKE SCOPE — heading + EmphasisMark + IME gate + code-fence guard.
 * Plan 05-07 extends to: list bullets (D-04), blockquote (EDIT-05),
 * inline code (EDIT-06), HR (EDIT-07).
 *
 * D-09: HIDEABLE markers inside FencedCode or InlineCode never hide.
 * D-07/D-31: rebuild is skipped when view.composing; existing
 * decorations are mapped through u.changes to keep positions valid.
 *
 * Decisions:
 * - Headings use Decoration.line (NOT Decoration.mark on text spans)
 *   per Pitfall 3 / EDIT-02 — line decoration on the wrapper, font-size
 *   on .cm-heading-N in CSS — prevents cursor jumps when crossing line.
 * - HeaderMark + EmphasisMark hide via Decoration.replace({}) (zero-
 *   width) when off-line, render via Decoration.mark({class: "cm-marker"})
 *   when on-line.
 *
 * Node names verified by spike (Plan 05-01 findings):
 * - Frontmatter (lowercase m) — NOT "FrontMatter"
 * - ATXHeading1..ATXHeading6, SetextHeading1, SetextHeading2
 * - HeaderMark — `#` markers
 * - StrongEmphasis, Emphasis, EmphasisMark
 * - FencedCode, InlineCode
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
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

// SPIKE SCOPE: HeaderMark + EmphasisMark only.
// Plan 05-07 extends with additional block/inline markers (see 05-SPIKE-FINDINGS.md).
export const HIDEABLE_MARKER_NODES = new Set<string>([
  "HeaderMark",
  "EmphasisMark",
]);

export const STRONG_MARK_CLASS = "cm-strong";
export const EM_MARK_CLASS = "cm-emphasis";
export const VISIBLE_MARKER_CLASS = "cm-marker";

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
 * Walk the parent chain of a syntax node to detect code-block context.
 * D-09: if any ancestor is FencedCode or InlineCode, the marker must NOT be hidden.
 */
function isInsideCode(node: SyntaxNodeRef): boolean {
  let p = node.node.parent;
  while (p) {
    if (p.name === "FencedCode" || p.name === "InlineCode") return true;
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
  //   lineDecs  — Decoration.line entries (zero-width, from===to)
  //   markDecs  — Decoration.mark / Decoration.replace (inline spans)
  //
  // RangeSetBuilder requires strictly sorted input by (from, startSide).
  // Line decorations at position P must be added BEFORE inline marks at P.
  // We guarantee this by sorting lineDecs and markDecs independently and
  // interleaving them with line-before-mark priority.
  const lineDecos: { from: number; deco: Decoration }[] = [];
  const markDecos: Entry[] = [];

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        // --- Heading line decoration (D-EDIT-02) ---
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

        // --- Emphasis span decorations (StrongEmphasis, Emphasis) ---
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

        // --- Hideable marker decoration (HeaderMark, EmphasisMark) ---
        // Off-line → Decoration.replace({}) hides the marker character(s).
        // On-line  → Decoration.mark({class:"cm-marker"}) shows them styled.
        // D-09: markers inside FencedCode or InlineCode are NEVER hidden.
        if (HIDEABLE_MARKER_NODES.has(node.name)) {
          if (isInsideCode(node)) return; // D-09
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
