/**
 * jasperKeymap — Cmd+S save plus the Cmd+F / Cmd+Opt+F Find bar openers
 * (WS-09). The built-in search panel and searchKeymap are not used; the custom
 * FindReplaceBar drives @codemirror/search directly, so both shortcuts are
 * reclaimed from the browser's native find with preventDefault.
 *
 * Callbacks are closed over via a stable cbRef, so the keymap always reaches
 * the latest handler without rebuilding the EditorView.
 *
 * listEnterCommand must be installed at Prec.high BEFORE markdown(), which
 * registers insertNewlineContinueMarkup at the same precedence — order breaks
 * the tie.
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
 * listEnterCommand replaces insertNewlineContinueMarkup for `-`/`*`/`+` bullets
 * and task items, which otherwise preserves "loose" list spacing and leaves a
 * stray blank line when exiting an empty item at end-of-document.
 *
 *   - non-empty item, cursor at end → newline, same indent, same marker
 *     (task markers reset to `[ ]`)
 *   - empty item, top level         → clear the marker in place
 *   - empty item, nested            → de-indent one level
 *
 * Anything else returns false and falls through.
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
 * Find/Replace bar (WS-09). Both preventDefault the browser's
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
 * toggleItalic wraps or strips `*`. Known trade-off: the naive strip cannot
 * tell `*foo*` (italic) from `* foo` (a bullet). Cmd+Z undoes it.
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
