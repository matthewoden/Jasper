/**
 * jasperKeymap — CM6 keymap factory for the Cmd+S save shortcut and (P26,
 * WS-09/D-02) the Cmd+F / Cmd+Opt+F pane Find/Replace bar openers.
 * Find/Replace is a custom per-pane React bar (FindReplaceBar.tsx) that
 * drives @codemirror/search commands directly against the pane's EditorView
 * — searchKeymap and the built-in search panel are not used. findBarKeymap
 * reclaims Cmd+F (find-only) and Cmd+Opt+F (find+replace) from the browser's
 * native find, preventDefault-ing both.
 *
 * The save/find-open callbacks are captured by closure; MarkdownEditor passes
 * stable cbRef-routed callbacks so the keymap always calls the latest handler
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
import { getIndentUnit } from "@codemirror/language";
import type { Extension } from "@codemirror/state";


// Leading whitespace + unordered marker (`- `/`* `/`+ `) + optional task
// checkbox (`[ ] `/`[x] `/`[X] `) + the remaining content. Ordered lists and
// non-list lines don't match and fall through to CodeMirror.
const LIST_ITEM_RE = /^(\s*)([-*+] )(\[[ xX]\] )?(.*)$/;

/**
 * listEnterCommand — Enter handler for unordered bullet/task list items.
 *
 * CodeMirror's insertNewlineContinueMarkup has two behaviors Jasper does not
 * want: it preserves "loose" list spacing (a blank line between items, then
 * re-inserts that blank before every new item), and it leaves a stray blank
 * line when exiting an empty item at end-of-document. This command takes over
 * Enter for `-`/`*`/`+` bullets and task items to keep things tight:
 *
 *   - non-empty item, cursor at end of line → continue tightly: newline + same
 *     indent + same marker (task markers reset `[x]`→`[ ]`)
 *   - empty item, top level                 → clear the marker in place (exit)
 *   - empty item, nested                     → de-indent one level (keep marker,
 *     cursor stays at end of line)
 *
 * Everything else — cursor mid-line, ordered lists (`1.`), non-list lines —
 * returns false and falls through. Must be installed at Prec.high BEFORE the
 * markdown() extension so it wins on a precedence tie. De-indent strips one
 * indentUnit (2 spaces by default), matching Shift-Tab.
 */
export function listEnterCommand(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (sel.from !== sel.to) return false; // collapsed cursor only

  const line = state.doc.lineAt(sel.from);
  const m = LIST_ITEM_RE.exec(line.text);
  if (!m) return false; // not an unordered bullet/task item

  const [, indent, bullet, task, content] = m;
  const isEmpty = content.trim() === "";

  // Non-empty item → continue the list tightly. A mid-line Enter is a content
  // split, which we leave to CodeMirror.
  if (!isEmpty) {
    if (sel.from !== line.to) return false;
    const insert = `\n${indent}${bullet}${task ? "[ ] " : ""}`;
    view.dispatch({
      changes: { from: sel.from, insert },
      selection: { anchor: sel.from + insert.length },
      scrollIntoView: true,
      userEvent: "input",
    });
    return true;
  }

  // Empty top-level item → clear the marker in place (exit the list).
  if (indent === "") {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: "" },
      selection: { anchor: line.from },
      scrollIntoView: true,
      userEvent: "delete.list-exit",
    });
    return true;
  }

  // Empty nested item → de-indent one level (strip one tab, or `unit` spaces).
  // Keep the cursor at the end of the line (it shifts left only by the removed
  // indent) rather than jumping to the start of the marker.
  const unit = getIndentUnit(state);
  const strip = indent.startsWith("\t") ? 1 : Math.min(unit, indent.length);
  const newIndent = indent.slice(strip);
  view.dispatch({
    changes: { from: line.from, to: line.from + indent.length, insert: newIndent },
    selection: { anchor: line.to - strip },
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

/**
 * findBarKeymap — Cmd+F / Cmd+Opt+F bindings that open the pane's custom
 * Find/Replace bar (P26, WS-09/D-02). Both preventDefault the browser's
 * native find; the actual bar UI opens in React (LeafPane), so `run` always
 * returns true regardless of the callback's own effect.
 */
export function findBarKeymap(
  onOpenFind: () => void,
  onOpenFindReplace: () => void,
): Extension {
  return keymap.of([
    {
      key: "Mod-f",
      preventDefault: true,
      run: () => {
        onOpenFind();
        return true;
      },
    },
    {
      key: "Mod-Alt-f",
      preventDefault: true,
      run: () => {
        onOpenFindReplace();
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
