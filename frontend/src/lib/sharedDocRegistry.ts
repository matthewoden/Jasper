/**
 * sharedDocRegistry — N live EditorViews over one logical document (WS-10),
 * generalizing CM6's two-view "Split View" example to a noteId-keyed registry.
 *
 * Each view keeps its own selection/scroll/fold. Only `changes` are
 * re-dispatched to the others, tagged with syncAnnotation so the receiving
 * view does not re-broadcast and loop forever.
 *
 * A plain Map + Set, deliberately not a Zustand store: EditorViews are mutable,
 * non-serializable and identity-sensitive, so reactive state would either break
 * shallow-equality re-renders or invite treating a view as immutable data.
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
 * Undo history does NOT survive Compartment.reconfigure promotion — proven by
 * the spike. So a departing PRIMARY with survivors is kept alive and still
 * primary; the caller must detach it from the DOM but NOT destroy it, and
 * Undo/Redo keeps routing to that off-DOM view with its full history.
 *
 * A SECOND unregister of an already-detached primary means a real release; by
 * then there is no history left to protect, so a survivor is promoted normally.
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
  // If the primary was already detached (its own
  // pane closed while a survivor remained) and the view just removed here
  // was the LAST survivor, no live view depends on the detached primary's
  // history any longer — release it too so the registry entry, the primary
  // EditorView, and (via EditorPane's getPrimaryView(id) === null gate) the
  // note's NoteBufferController all get torn down. Without this, closing the
  // originally-opened (primary) pane before its siblings leaked the detached
  // primary + registry entry + controller forever.
  if (entry.primaryDetached && entry.views.size === 1 && entry.views.has(entry.primary!)) {
    entry.views.delete(entry.primary!);
    registry.delete(noteId);
    return;
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

/**
 * Per-view history Compartment, tracked so promotion can reconfigure a SPECIFIC
 * survivor's own. Populated lazily from a ViewPlugin because the EditorView does
 * not exist yet when its own extensions array is built.
 */
const historyCompartments = new WeakMap<EditorView, Compartment>();

/**
 * Returns the CM6 extensions that make a view either the single undo-history
 * owner for `noteId` (`isPrimary`) or a history-less secondary whose
 * Undo/Redo keys route to the registry's CURRENT primary view instead of a
 * local (absent) history — see `unregisterView`'s docs for the promotion
 * behavior.
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
