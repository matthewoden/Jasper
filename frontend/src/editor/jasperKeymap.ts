/**
 * jasperKeymap — CM6 keymap factory for the Cmd+S save shortcut.
 * Find/Replace is provided by @codemirror/search's searchKeymap (already wired
 * in MarkdownEditor's extensions array) — this file does NOT re-bind Cmd+F.
 *
 * The save callback is captured by closure; MarkdownEditor passes a stable
 * cbRef-routed callback so the keymap always calls the latest handler
 * without rebuilding the EditorView.
 *
 * Also exports toggleBold and toggleItalic: wrap/unwrap selection with `**`/`*`.
 *
 * Italic trade-off: naïve wrap/strip does not distinguish `*foo*` (italic)
 * from `* foo` (bullet list). User can undo with Cmd+Z.
 *
 * Also exports listEnterCommand: custom Enter handler for the nested-empty-item
 * de-indent behavior. Must be installed at Prec.high so it runs before
 * @codemirror/lang-markdown's insertNewlineContinueMarkup (also Prec.high, but
 * extension order determines priority within the same precedence).
 */
import { keymap, EditorView } from "@codemirror/view";
import type { KeyBinding } from "@codemirror/view";
import { getIndentUnit, indentUnit } from "@codemirror/language";
import type { Extension } from "@codemirror/state";


/**
 * listEnterCommand — custom Enter handler for the empty-list-item case.
 *
 * SPEC:
 *   - Enter on a NON-EMPTY list/task item → return false, falling through to
 *     insertNewlineContinueMarkup which creates a new sibling item.
 *   - Enter on an EMPTY item at TOP LEVEL (no leading whitespace) → clear the
 *     marker in place (exit the list), no extra blank line, return true. CM6's
 *     insertNewlineContinueMarkup mishandles this case on a trailing/last empty
 *     item — it inserts a blank line AND keeps the marker (`- [ ] ` + Enter →
 *     `\n\n- [ ] `). Short-circuiting it here is the whole point.
 *   - Enter on an EMPTY item that is INDENTED (nested) → de-indent one level
 *     (strip one indentUnit from the leading whitespace, keep the marker,
 *     cursor stays on same line). Pressing Enter again de-indents another level
 *     until top-level, where the next Enter clears the marker in place (exit).
 *
 * Applies uniformly to plain bullet items (`- `) and task items (`- [ ] `).
 * De-indent unit matches Shift-Tab (both use @codemirror/language indentUnit,
 * defaulting to 2 spaces when no indentUnit facet is configured).
 *
 * Returns true for both empty cases (top-level clear and nested de-indent);
 * non-empty items return false and fall through to insertNewlineContinueMarkup
 * (Prec.high from the markdown() extension). Must be installed at Prec.high
 * BEFORE the markdown() extension so it wins when precedence ties.
 *
 * Empty-item detection: line text is ONLY leading whitespace + list marker
 * (with optional task checkbox marker) + trailing spaces. No other content.
 * Supported markers: `- `, `- [ ] `, `- [x] `, `* `, `* [ ] `.
 */
export function listEnterCommand(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  // Only act on a collapsed cursor (not a selection)
  if (sel.from !== sel.to) return false;

  const line = state.doc.lineAt(sel.from);
  const text = line.text;

  // Top-level empty item: NO leading whitespace. Mutually exclusive with the
  // nested regex below (which requires \s+), so nested still wins for indented
  // lines. Clear the marker in place to exit the list without a blank line.
  const EMPTY_TOPLEVEL_ITEM_RE = /^([-*+] )(?:\[[ xX]\] )?\s*$/;
  if (EMPTY_TOPLEVEL_ITEM_RE.test(text)) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: "" },
      selection: { anchor: line.from },
      scrollIntoView: true,
      userEvent: "delete.list-exit",
    });
    return true;
  }

  // Match: leading whitespace (at least one space/tab) + list marker + optional task marker + optional trailing spaces
  // The "text after marker" must be empty (only marker + optional trailing spaces, no other content).
  // Regex: (leading_ws)(marker)(optional_task_marker)(optional_trailing_spaces)$
  // marker: `- ` or `* ` or `+ `
  // task_marker: `[ ] ` or `[x] ` or `[X] ` (with trailing space)
  const EMPTY_INDENTED_ITEM_RE = /^(\s+)([-*+] )(?:\[[ xX]\] )?$/;
  const match = EMPTY_INDENTED_ITEM_RE.exec(text);
  if (!match) return false;

  // The item is empty AND indented — de-indent one level
  const leadingWs = match[1];
  const indentUnitStr = state.facet(indentUnit);
  const unitSize = getIndentUnit(state);
  const currentIndentCols = leadingWs.length; // simplified: assumes spaces only

  if (currentIndentCols === 0) {
    // This shouldn't match (regex requires \s+), but guard anyway — fall through
    return false;
  }

  // Compute new indentation: strip one unit
  const newIndentCols = Math.max(0, currentIndentCols - unitSize);
  // Build new indent string (spaces — matches indentUnit convention)
  const indentChar = indentUnitStr[0] === "\t" ? "\t" : " ";
  const newIndent = indentChar === "\t"
    ? "\t".repeat(Math.floor(newIndentCols / state.tabSize))
    : " ".repeat(newIndentCols);

  // Replace the leading whitespace with the new (reduced) indent
  const changes = {
    from: line.from,
    to: line.from + leadingWs.length,
    insert: newIndent,
  };

  // Position cursor after the new indent (at the start of the marker)
  const newCursorPos = line.from + newIndent.length;

  view.dispatch({
    changes,
    selection: { anchor: newCursorPos },
    scrollIntoView: true,
    userEvent: "delete.dedent",
  });
  return true;
}

/**
 * listEnterKeymap — keymap entry for listEnterCommand.
 * Install at Prec.high so it runs before insertNewlineContinueMarkup.
 */
export const listEnterKeymap: KeyBinding = { key: "Enter", run: listEnterCommand };

export function saveKeymap(onSave: () => void): Extension {
  return keymap.of([
    {
      key: "Mod-s",
      preventDefault: true,
      run: () => {
        onSave();
        return true;
      },
    },
  ]);
}


function wrapWith(view: EditorView, marker: string): boolean {
  const state = view.state;
  const changes: { from: number; to: number; insert: string }[] = [];
  let cursorInsertPos: number | null = null;

  for (const r of state.selection.ranges) {
    const isEmpty = r.from === r.to;
    const sel = state.sliceDoc(r.from, r.to);

    if (isEmpty) {
      changes.push({ from: r.from, to: r.to, insert: `${marker}${marker}` });
      cursorInsertPos = r.from + marker.length;
    } else if (sel.startsWith(marker) && sel.endsWith(marker) && sel.length >= marker.length * 2) {
      changes.push({ from: r.from, to: r.to, insert: sel.slice(marker.length, sel.length - marker.length) });
    } else {
      const before = state.sliceDoc(Math.max(0, r.from - marker.length), r.from);
      const after = state.sliceDoc(r.to, Math.min(state.doc.length, r.to + marker.length));
      if (before === marker && after === marker) {
        changes.push({ from: r.from - marker.length, to: r.to + marker.length, insert: sel });
      } else {
        changes.push({ from: r.from, to: r.to, insert: `${marker}${sel}${marker}` });
      }
    }
  }

  view.dispatch({ changes });

  if (cursorInsertPos !== null) {
    view.dispatch({ selection: { anchor: cursorInsertPos } });
  }

  return true;
}

/**
 * toggleBold — wraps the selection with `**` (bold markdown).
 * If already wrapped, strips the `**` markers (toggle off).
 * With no selection, inserts `**|**` (cursor between).
 *
 * Bound to Mod-b (Cmd+B on macOS, Ctrl+B elsewhere) via jasperKeymap.
 */
export function toggleBold(view: EditorView): boolean {
  return wrapWith(view, "**");
}

/**
 * toggleItalic — wraps the selection with `*` (italic markdown).
 * If already wrapped, strips the `*` markers (toggle off).
 * With no selection, inserts `*|*` (cursor between).
 *
 * v1 trade-off: naïve strip does not distinguish `*foo*` (italic) from
 * `* foo` (bullet list start). User can undo with Cmd+Z if needed.
 *
 * Bound to Mod-i (Cmd+I on macOS, Ctrl+I elsewhere) via jasperKeymap.
 */
export function toggleItalic(view: EditorView): boolean {
  return wrapWith(view, "*");
}


/**
 * jasperKeymap — CM6 KeyBinding array for project-specific shortcuts.
 * Wire into MarkdownEditor.tsx via keymap.of([...jasperKeymap, ...]).
 *
 * "Mod-" expands to Cmd on macOS and Ctrl on other platforms (CM6 standard).
 * preventDefault: true suppresses the browser default (OS font panel, etc.)
 * even if a command returns false — all commands here always return true.
 */
export const jasperKeymap: KeyBinding[] = [
  { key: "Mod-b", run: toggleBold, preventDefault: true },
  { key: "Mod-i", run: toggleItalic, preventDefault: true },
];
