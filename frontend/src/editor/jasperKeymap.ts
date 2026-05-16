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
 *
 * Plan 07-24 (UAT-2 R1-4): Added toggleBold and toggleItalic commands
 * that wrap/unwrap the selection with `**` / `*` markers (Obsidian-style).
 * These are exported as a jasperKeymap KeyBinding[] and wired into
 * MarkdownEditor.tsx's keymap.of([...]) call.
 *
 * Trade-off note (italic vs bullet lists): The italic command (`*`) uses
 * naïve wrap/strip — it does NOT distinguish `*foo*` (italic) from `* foo`
 * (bullet list item) when the selection or flanking context starts at
 * line-beginning. v1 lean: naïve is acceptable; the user can undo with
 * Cmd+Z if it bites a list item. This trade-off is documented in
 * 07-24-SUMMARY.md under "Known Trade-offs".
 */
import { keymap } from "@codemirror/view";
import type { KeyBinding } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

// ─────────────────────────────────────────────────────────────────────────────
// Plan 05-11 — Cmd+S save shortcut
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Plan 07-24 — toggleBold / toggleItalic (UAT-2 R1-4)
//
// Design: a single `wrapWith(view, marker)` helper handles both commands.
// It iterates the selection's ranges and for each range determines whether to:
//   (A) Toggle off: the selected text itself starts+ends with the marker
//       (e.g., selection is "**foo**" → strip to "foo")
//   (B) Toggle off: the selection is the INNER content and the surrounding
//       context (before/after) are the marker (e.g., cursor is on "foo" inside
//       "**foo**" → extend the change to strip the outer "**" pairs)
//   (C) Wrap: insert marker before and after the selection
//       (e.g., "foo" → "**foo**"; empty → "****" with cursor between)
//
// After dispatch, for the empty-cursor case (no selection), CM6 places the
// cursor at the END of the inserted text (i.e., after the closing marker).
// We adjust the selection with a second dispatch to move the cursor BETWEEN
// the two marker strings (at r.from + marker.length).
// ─────────────────────────────────────────────────────────────────────────────

function wrapWith(view: EditorView, marker: string): boolean {
  const state = view.state;
  const changes: { from: number; to: number; insert: string }[] = [];
  let cursorInsertPos: number | null = null;

  for (const r of state.selection.ranges) {
    const isEmpty = r.from === r.to;
    const sel = state.sliceDoc(r.from, r.to);

    if (isEmpty) {
      // Insert marker pair; cursor position recorded for post-dispatch adjustment
      changes.push({ from: r.from, to: r.to, insert: `${marker}${marker}` });
      cursorInsertPos = r.from + marker.length;
    } else if (sel.startsWith(marker) && sel.endsWith(marker) && sel.length >= marker.length * 2) {
      // (A) Toggle off: selection is the full marked span, e.g. "**foo**"
      changes.push({ from: r.from, to: r.to, insert: sel.slice(marker.length, sel.length - marker.length) });
    } else {
      // Check (B): is the selection's surrounding context the marker?
      const before = state.sliceDoc(Math.max(0, r.from - marker.length), r.from);
      const after = state.sliceDoc(r.to, Math.min(state.doc.length, r.to + marker.length));
      if (before === marker && after === marker) {
        // Toggle off: extend the change range to include the surrounding markers
        changes.push({ from: r.from - marker.length, to: r.to + marker.length, insert: sel });
      } else {
        // (C) Wrap: insert marker pair around the selection
        changes.push({ from: r.from, to: r.to, insert: `${marker}${sel}${marker}` });
      }
    }
  }

  view.dispatch({ changes });

  // For empty-cursor insertion, adjust cursor to sit between the two markers
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

// ─────────────────────────────────────────────────────────────────────────────
// Plan 07-36 (UAT-3 N7): Cmd+U underline REMOVED.
// Plan 07-27 added a Mod-u → toggleUnderline binding that wrapped the selection
// in <u>...</u> HTML tags. The CM6 markdown editor renders raw markdown source —
// inline HTML tags are NOT interpreted, so the user saw literal "<u>text</u>"
// characters instead of an underline. Reverted per UAT-3 N7. See
// 07-CONTEXT.md D-51 "REMOVED 2026-05-15 (UAT-3 N7)" sub-section for full
// rationale and v2 deferral plan.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * jasperKeymap — CM6 KeyBinding array for project-specific shortcuts.
 *
 * Plan 07-24: Mod-b → toggleBold, Mod-i → toggleItalic.
 * Plan 07-36: Mod-u underline removed (UAT-3 N7).
 * Wire into MarkdownEditor.tsx via keymap.of([...jasperKeymap, ...]).
 *
 * "Mod-" expands to Cmd on macOS and Ctrl on other platforms (CM6 standard).
 * preventDefault: true ensures the browser default (OS font panel, etc.) is
 * suppressed even if the command returns false (defensive; all commands
 * always return true when they handle the key).
 */
export const jasperKeymap: KeyBinding[] = [
  { key: "Mod-b", run: toggleBold, preventDefault: true },
  { key: "Mod-i", run: toggleItalic, preventDefault: true },
];
