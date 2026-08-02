/**
 * codeblockExpand completes a fence on Enter: typing ``` and pressing Enter
 * leaves the cursor on a blank line with the closing fence already below.
 *
 * The load-bearing guard is the fence count ABOVE the cursor. An EVEN count
 * means this line opens an unbalanced block, so expand; an ODD count means it
 * closes an open one, so let Enter through untouched.
 */
import { keymap } from "@codemirror/view";

const FENCE_LINE_RE = /^\s*```[a-zA-Z0-9_-]*\s*$/;

interface DocLike {
  line: (n: number) => { text: string };
  lines: number;
}

/** Count fence-shaped lines strictly above `lineNumber`. */
function countFencesAbove(doc: DocLike, lineNumber: number): number {
  let n = 0;
  for (let i = 1; i < lineNumber; i++) {
    if (FENCE_LINE_RE.test(doc.line(i).text)) n++;
  }
  return n;
}

/** True iff a fence-shaped line exists strictly below `lineNumber`. */
function hasFenceBelow(doc: DocLike, lineNumber: number): boolean {
  for (let i = lineNumber + 1; i <= doc.lines; i++) {
    if (FENCE_LINE_RE.test(doc.line(i).text)) return true;
  }
  return false;
}

export const codeblockExpand = keymap.of([
  {
    key: "Enter",
    run: (view) => {
      const sel = view.state.selection.main;
      if (sel.from !== sel.to) return false;
      const line = view.state.doc.lineAt(sel.from);
      if (sel.from !== line.to) return false;
      if (!FENCE_LINE_RE.test(line.text)) return false;
      const above = countFencesAbove(view.state.doc, line.number);
      if (above % 2 === 1) return false;
      if (hasFenceBelow(view.state.doc, line.number)) return false;

      const insert = "\n\n```";
      const cursorAt = line.to + 1;
      view.dispatch({
        changes: { from: line.to, insert },
        selection: { anchor: cursorAt },
        scrollIntoView: true,
      });
      return true;
    },
  },
]);
