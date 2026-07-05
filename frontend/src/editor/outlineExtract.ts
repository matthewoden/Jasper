/**
 * outlineExtract — extracts H1-H6 headings from the LIVE CM6 document via
 * the lezer syntax tree (not the saved file, not a regex line-scanner).
 *
 * Reuses the heading node-name table and the FencedCode-ancestor guard from
 * livePreviewPlugin.ts so headings inside fenced code blocks are excluded
 * for free, and Setext (underline-style) headings are recognized alongside
 * ATX (`#`-prefixed) headings.
 *
 * Unlike livePreviewPlugin's decoration walk, this walks the WHOLE document
 * (no visibleRanges restriction) since the outline needs every heading, not
 * just the ones currently on screen.
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";

export interface HeadingInfo {
  level: number;
  text: string;
  line: number;
  from: number;
}

const HEADING_LEVEL: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

const SETEXT_NODE_NAMES = new Set<string>(["SetextHeading1", "SetextHeading2"]);

/**
 * Walk the parent chain of a syntax node to detect fenced code context.
 * Mirrors livePreviewPlugin.ts's isInsideCode guard verbatim.
 */
function isInsideCode(node: SyntaxNodeRef): boolean {
  let p = node.node.parent;
  while (p) {
    if (p.name === "FencedCode") return true;
    p = p.parent;
  }
  return false;
}

/**
 * Extracts the heading TEXT for a given node, stripping the ATX marker
 * (`#{1,6}` + following whitespace) for ATX headings, or using the first
 * line of the heading (excluding the underline) for Setext headings.
 */
function extractHeadingText(state: EditorState, node: SyntaxNodeRef): string {
  if (SETEXT_NODE_NAMES.has(node.name)) {
    // Setext headings span the text line(s) plus the underline line(s) below
    // them; the first line of the node is the text, the underline is not
    // part of what we display.
    const firstLine = state.doc.lineAt(node.from);
    return firstLine.text.trim();
  }
  const line = state.doc.lineAt(node.from);
  return line.text.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\s+#*\s*$/, "").trim();
}

/**
 * Returns the doc offset + 1-based line number of the line where the
 * heading's displayed text begins (for ATX and Setext alike, this is the
 * first line of the node).
 */
function headingLineStart(state: EditorState, node: SyntaxNodeRef): { line: number; from: number } {
  const line = state.doc.lineAt(node.from);
  return { line: line.number, from: line.from };
}

/**
 * extractHeadings — walks the whole document's syntax tree and returns
 * every H1-H6 heading in document order, excluding any heading nested
 * inside a fenced code block.
 */
export function extractHeadings(state: EditorState): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  // Unlike livePreviewPlugin's viewport-scoped decorations (which only need
  // whatever CM6's incremental background parser has already covered near the
  // visible range), the outline needs the WHOLE document — including content
  // far outside the initial viewport. A bare `syntaxTree(state)` can silently
  // return a tree that only covers the parser's initial budget (e.g. content
  // loaded via a single large docChanged transaction, such as the initial
  // GET-load or a note swap, may only be partially parsed at the moment this
  // runs), which either drops headings beyond that point or resolves their
  // `from` position off a still-incomplete tree. `ensureSyntaxTree` forces a
  // synchronous parse up to the full document length (bounded by the timeout
  // so a pathologically huge note can't freeze typing); falling back to the
  // best-effort `syntaxTree(state)` only if that budget is exceeded.
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);

  tree.iterate({
    enter(node: SyntaxNodeRef) {
      const level = HEADING_LEVEL[node.name];
      if (level === undefined) return;
      if (isInsideCode(node)) return;

      const text = extractHeadingText(state, node);
      const { line, from } = headingLineStart(state, node);
      headings.push({ level, text, line, from });
    },
  });

  return headings;
}
