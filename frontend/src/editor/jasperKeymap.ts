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
 */
import { keymap } from "@codemirror/view";
import type { KeyBinding } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";


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
