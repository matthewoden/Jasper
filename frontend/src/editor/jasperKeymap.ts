/**
 * jasperKeymap — Phase 5 / Plan 05-11. CM6 keymap factory for the
 * Cmd+S save shortcut (EDIT-10). Find/Replace (EDIT-11) is provided
 * by @codemirror/search's searchKeymap, already wired by Plan 05-05's
 * MarkdownEditor extensions array — this file does NOT re-bind Cmd+F.
 *
 * Translation note: EditorPane.tsx lines 516-530 had a textarea
 * onKeyDown that detected `(e.metaKey || e.ctrlKey) && key === 's'`,
 * called preventDefault, and dispatched performSave. CM6 keymap
 * "Mod-s" expands to Cmd-s on Mac and Ctrl-s on other platforms —
 * same semantic. Returning true from a keymap run = handled (CM6's
 * preventDefault equivalent).
 *
 * The save callback is captured by closure, so MarkdownEditor passes
 * a stable cbRef-routed callback (NOT the prop directly) to keep the
 * EditorView's keymap pointing at the latest handler without
 * rebuilding the editor.
 */
import { keymap } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export function saveKeymap(onSave: () => void): Extension {
  return keymap.of([
    {
      key: "Mod-s",
      preventDefault: true,
      run: () => {
        onSave();
        return true; // CM6 keymap: returning true = handled (≈ preventDefault)
      },
    },
  ]);
}
