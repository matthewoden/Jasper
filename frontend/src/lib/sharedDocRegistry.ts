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
import { redo, undo, history } from "@codemirror/commands";
import { Annotation, Compartment, type Extension, type Transaction } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin } from "@codemirror/view";

/** Tags a re-dispatched transaction so the receiving view's own dispatch does not re-broadcast it. */
export const syncAnnotation = Annotation.define<boolean>();

interface DocEntry {
  views: Set<EditorView>;
  primary: EditorView | null;
  /** True once the primary has unregistered but was kept alive off-DOM because a survivor remained (Pattern 2 / Task 2). */
  primaryDetached: boolean;
}

const registry = new Map<string, DocEntry>();

/** Registers a live EditorView for a note. The first view (or an explicit isPrimary) owns undo history — see Pattern 2 / historyExtensionFor. */
export function registerView(noteId: string, view: EditorView, isPrimary: boolean): void {
  const entry = registry.get(noteId) ?? { views: new Set(), primary: null, primaryDetached: false };
  entry.views.add(view);
  if (isPrimary || entry.primary === null) entry.primary = view;
  registry.set(noteId, entry);
}

/**
 * Unregisters a view.
 *
 * SPIKE OUTCOME (Plan 01, `sharedDocRegistry.spike.test.ts`): undo history
 * does NOT survive `Compartment.reconfigure` promotion. So when the removed
 * view IS the current primary and at least one other view for the note is
 * still registered, the primary is kept alive (stays in `entry.views`, stays
 * `entry.primary`) rather than destroyed/promoted-away — the caller must NOT
 * call `view.destroy()` in that case, only detach it from the DOM. Undo/Redo
 * for the note keeps routing to this same (possibly off-DOM) view via
 * `historyExtensionFor`'s keymap, so it reflects the full pre-close history.
 *
 * If `unregisterView` is called a SECOND time for an already-detached
 * primary, the caller is truly releasing it for good (e.g. the note is fully
 * closed everywhere reachable from that view). If other views still remain
 * at that point, there is no history left to protect for the departing view
 * either way, so a survivor is promoted via the plain
 * `historyCompartment.reconfigure(history())` path.
 */
export function unregisterView(noteId: string, view: EditorView): void {
  const entry = registry.get(noteId);
  if (!entry) return;

  if (view === entry.primary) {
    const survivors = [...entry.views].filter((v) => v !== view);

    if (survivors.length === 0) {
      entry.views.delete(view);
      registry.delete(noteId);
      return;
    }

    if (!entry.primaryDetached) {
      entry.primaryDetached = true;
      return;
    }

    entry.views.delete(view);
    const next = survivors[0];
    const historyCompartment = historyCompartments.get(next);
    if (historyCompartment) {
      next.dispatch({ effects: historyCompartment.reconfigure(history()) });
    }
    entry.primary = next;
    entry.primaryDetached = false;
    return;
  }

  entry.views.delete(view);
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

/**
 * Per-view Compartment wrapping that view's `history()` extension (or `[]`
 * for secondaries), tracked so `unregisterView`'s far-edge promotion path can
 * later `.reconfigure()` a SPECIFIC survivor's own compartment. Populated
 * lazily via a `ViewPlugin` (fired with the real, constructed `EditorView`)
 * rather than a constructor-time `view` argument, since the view instance
 * does not exist yet at the point its own extensions array is built (the
 * same construction-order constraint `MarkdownEditor.tsx`'s `viewRef` works
 * around with a ref set after `new EditorView(...)` returns).
 */
const historyCompartments = new WeakMap<EditorView, Compartment>();

/**
 * Returns the CM6 extensions that make a view either the single undo-history
 * owner for `noteId` (`isPrimary`) or a history-less secondary whose
 * Undo/Redo keys route to the registry's CURRENT primary view instead of a
 * local (absent) history — see Pattern 2 / Pitfall 2 and `unregisterView`'s
 * docs for the promotion behavior.
 */
export function historyExtensionFor(noteId: string, isPrimary: boolean): Extension {
  const historyCompartment = new Compartment();
  const trackOwnView = ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        historyCompartments.set(view, historyCompartment);
      }
    },
  );

  const routeUndo = (): boolean => {
    const primary = getPrimaryView(noteId);
    return primary ? undo(primary) : false;
  };
  const routeRedo = (): boolean => {
    const primary = getPrimaryView(noteId);
    return primary ? redo(primary) : false;
  };

  return [
    historyCompartment.of(isPrimary ? history() : []),
    trackOwnView,
    // Every view (primary included) routes Undo/Redo through the registry's
    // CURRENT primary, never its own local history field — this is what
    // keeps a single linear undo timeline per note regardless of which pane
    // the keystroke was typed in.
    keymap.of([
      { key: "Mod-z", run: routeUndo, preventDefault: true },
      { key: "Mod-Shift-z", run: routeRedo, preventDefault: true },
      { key: "Mod-y", run: routeRedo, preventDefault: true },
    ]),
  ];
}
