/**
 * outlineExtract pulls headings from the LIVE CM6 tree, not the saved file.
 *
 * Reuses livePreviewPlugin's node table and FencedCode guard, so headings inside
 * code blocks are excluded and Setext headings are recognized for free.
 *
 * Walks the WHOLE document, not just visibleRanges — the outline needs every
 * heading, not the on-screen ones.
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
  // A bare syntaxTree() can return a tree covering only the parser's initial
  // budget — likely here, since content arrives in one large docChanged — which
  // drops headings past that point or resolves them off an incomplete tree.
  // ensureSyntaxTree forces a full parse, bounded so a huge note cannot freeze
  // typing, falling back to best-effort if that budget is exceeded.
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
