/**
 * sharedDocRegistry — N-way CodeMirror shared-document sync registry (WS-10).
 *
 * Generalizes the official CM6 "Split View" example
 * (https://codemirror.net/examples/split/) from exactly-2-views to a
 * noteId-keyed registry of N live `EditorView`s over one logical document.
 * Each view keeps its own independent selection/scroll/fold; only `changes`
 * (never `selection`) are re-dispatched to the OTHER views for the same
 * noteId, tagged with `syncAnnotation` so the receiving view's own custom
 * `dispatch` does not re-broadcast (no infinite loop).
 *
 * Deliberately a plain imperative module (Map + Set), NOT a Zustand store:
 * `EditorView` instances are mutable, non-serializable, and identity-
 * sensitive — putting them in reactive state would either break shallow-
 * equality re-renders or invite treating a view as immutable data it isn't
 * (see RESEARCH.md Anti-Patterns, Phase 25).
 */
import { Annotation, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Tags a re-dispatched transaction so the receiving view's own dispatch does not re-broadcast it. */
export const syncAnnotation = Annotation.define<boolean>();

interface DocEntry {
  views: Set<EditorView>;
  primary: EditorView | null;
}

const registry = new Map<string, DocEntry>();

/** Registers a live EditorView for a note. The first view (or an explicit isPrimary) owns undo history — see Pattern 2 / historyExtensionFor. */
export function registerView(noteId: string, view: EditorView, isPrimary: boolean): void {
  const entry = registry.get(noteId) ?? { views: new Set(), primary: null };
  entry.views.add(view);
  if (isPrimary || entry.primary === null) entry.primary = view;
  registry.set(noteId, entry);
}

/** Unregisters a view. See historyExtensionFor's module docs for the primary-unregister/keep-alive behavior (Pattern 2, Task 2). */
export function unregisterView(noteId: string, view: EditorView): void {
  const entry = registry.get(noteId);
  if (!entry) return;
  entry.views.delete(view);
  if (entry.primary === view) {
    entry.primary = entry.views.values().next().value ?? null;
  }
  if (entry.views.size === 0) registry.delete(noteId);
}

/** Returns the current primary EditorView for a note, or null if none is registered. */
export function getPrimaryView(noteId: string): EditorView | null {
  return registry.get(noteId)?.primary ?? null;
}

/**
 * Pass as the `dispatch` option when constructing each pane's EditorView.
 * Applies the transaction locally, then re-dispatches ONLY its `changes` to
 * every OTHER registered view for the same noteId — never the transaction's
 * `selection`, so mirrored edits never disturb another pane's cursor/scroll.
 */
export function syncDispatch(noteId: string, tr: Transaction, view: EditorView): void {
  view.update([tr]);
  if (tr.changes.empty || tr.annotation(syncAnnotation)) return;
  const entry = registry.get(noteId);
  if (!entry) return;
  for (const other of entry.views) {
    if (other === view) continue;
    other.dispatch({ changes: tr.changes, annotations: [syncAnnotation.of(true)] });
  }
}
