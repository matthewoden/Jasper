/**
 * codeblockExpand — Enter-key handler that turns a freshly-typed
 * ``` line into a bounded fenced-code block with the cursor sitting
 * inside.
 *
 * Trigger: cursor is at the END of a line whose trimmed content is
 * exactly "```" (or "```{language}", e.g. "```ts"). Pressing Enter
 * inserts:
 *
 *     [user line: ```]
 *     [empty line — cursor lands here]
 *     ```
 *     [empty line below for continuation]
 *
 * Net effect: the user has a finished fence with a closing marker
 * already in place AND a continuation line outside the fence to type
 * back into prose. Mirrors VS Code, Obsidian, and most editor
 * conventions for "complete the fence on Enter."
 *
 * Anti-trigger guards (return false → fall through to default Enter):
 *   - Cursor not at end of line.
 *   - Line content is not a bare ``` (with optional language tag).
 *   - The buffer already has a matching closing ``` further down — we
 *     don't want to nest fences inside an already-balanced one.
 */
import { keymap } from "@codemirror/view";

const FENCE_OPEN_RE = /^\s*```[a-zA-Z0-9_-]*\s*$/;
const FENCE_CLOSE_RE = /^\s*```\s*$/;

function hasMatchingCloseFence(
  doc: { line: (n: number) => { text: string }; lines: number },
  startLineNumber: number,
): boolean {
  for (let n = startLineNumber + 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (FENCE_CLOSE_RE.test(text)) return true;
    if (FENCE_OPEN_RE.test(text)) {
      // A second opening fence before a close means we're in the
      // unbalanced state and the user's typing the open of a new
      // block; auto-complete is appropriate here too.
      return false;
    }
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
      if (!FENCE_OPEN_RE.test(line.text)) return false;
      // If a matching close fence already exists below, this Enter is
      // navigating an existing block — leave it alone.
      if (hasMatchingCloseFence(view.state.doc, line.number)) return false;

      // Insert: \n[cursor]\n```\n
      // The empty line between the opening and closing fences is
      // where the user's caret lands; the trailing \n leaves a fresh
      // empty line below the closing fence to continue prose.
      const insert = "\n\n```\n";
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
