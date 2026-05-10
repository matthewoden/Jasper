/**
 * codeblockExpand — Enter-key handler that turns a freshly-typed
 * ``` line into a bounded fenced-code block with the cursor sitting
 * inside.
 *
 * Trigger: cursor is at the END of a line that IS the freshly-typed
 * OPENING fence of an unclosed block. Pressing Enter inserts:
 *
 *     [user line: ```]
 *     [empty line — cursor lands here]
 *     ```
 *
 * Net effect: the user has a finished fence with a closing marker
 * already in place. Mirrors VS Code, Obsidian, and most editor
 * conventions for "complete the fence on Enter."
 *
 * Anti-trigger guards (return false → fall through to default Enter):
 *   - Cursor not at end of line.
 *   - Line content is not a bare ``` (with optional language tag).
 *   - This line is the CLOSING fence of an already-open block. We
 *     detect this by counting fences in the lines ABOVE: an even
 *     count means we're outside any block (this line is opening an
 *     unbalanced one — expand); an odd count means we're inside an
 *     open block (this line is the close — let Enter pass through).
 *   - A balanced close already exists below.
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
      // Only act on a single-cursor (no selection range).
      if (sel.from !== sel.to) return false;
      const line = view.state.doc.lineAt(sel.from);
      // Cursor must be at end of line.
      if (sel.from !== line.to) return false;
      // Line must be a bare opening fence (optionally with language).
      if (!FENCE_LINE_RE.test(line.text)) return false;
      // If we're inside an already-open block, this line is the
      // CLOSING fence — let Enter pass through. Even fence count
      // above means we're outside any block; odd means inside.
      const above = countFencesAbove(view.state.doc, line.number);
      if (above % 2 === 1) return false;
      // Even count above (we're outside a block) AND a fence already
      // exists below means the doc is already balanced; this Enter
      // is navigating an existing block, not opening a new one.
      if (hasFenceBelow(view.state.doc, line.number)) return false;

      // Insert: \n[cursor]\n```
      // Cursor lands on the empty middle line between the two fences.
      // No extra trailing newline — the user can press Enter once
      // more to break out (and that Enter will pass through because
      // the closing-fence line we just inserted produces an odd count
      // above for THAT next Enter).
      const insert = "\n\n```";
      const cursorAt = line.to + 1; // start of the empty middle line
      view.dispatch({
        changes: { from: line.to, insert },
        selection: { anchor: cursorAt },
        scrollIntoView: true,
      });
      return true;
    },
  },
]);
