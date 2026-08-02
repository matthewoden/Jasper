/**
 * SPIKE: undo history does NOT survive Compartment.reconfigure.
 *
 * reconfigure swaps in a fresh history() whose private StateField initializes
 * empty — as far as that field is concerned it has never existed on this state.
 * Edits recorded before promotion are therefore not undoable after it.
 *
 * Consequence: a closing primary's EditorView must be kept alive off-DOM rather
 * than promoted away, until the note fully closes.
 */
import { describe, expect, it } from "vitest";
import { history, undo } from "@codemirror/commands";
import { Annotation, Compartment, EditorState, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Tags a re-dispatched transaction so the receiving view's own dispatch does not re-broadcast it. */
const syncAnnotation = Annotation.define<boolean>();

describe("sharedDocRegistry spike — undo-history promotion via Compartment.reconfigure (Open Question 1)", () => {
  it("documents whether undo history survives Compartment.reconfigure promotion", () => {
    const initialDoc = "hello";
    const historyCompartmentA = new Compartment();
    const historyCompartmentB = new Compartment();

    // Mutable holder so the two dispatch closures can forward-reference each
    // other's (not-yet-constructed) EditorView without needing `let` bindings.
    const refs: { a?: EditorView; b?: EditorView } = {};

    // Minimal local syncDispatch: apply the
    // transaction locally, then re-dispatch ONLY tr.changes (never selection)
    // to the other view, tagged so it does not re-broadcast.
    function dispatchA(tr: Transaction): void {
      refs.a!.update([tr]);
      if (tr.changes.empty || tr.annotation(syncAnnotation)) return;
      refs.b!.dispatch({ changes: tr.changes, annotations: [syncAnnotation.of(true)] });
    }
    function dispatchB(tr: Transaction): void {
      refs.b!.update([tr]);
      if (tr.changes.empty || tr.annotation(syncAnnotation)) return;
      refs.a!.dispatch({ changes: tr.changes, annotations: [syncAnnotation.of(true)] });
    }

    // View A is primary: owns history() in a Compartment.
    const viewA = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [historyCompartmentA.of(history())],
      }),
      dispatch: dispatchA,
    });
    refs.a = viewA;

    // View B is secondary: empty Compartment where history() would go.
    const viewB = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [historyCompartmentB.of([])],
      }),
      dispatch: dispatchB,
    });
    refs.b = viewB;

    // Edit through the primary (A); mirrors into B via syncDispatch.
    viewA.dispatch({ changes: { from: 5, insert: " world" } });
    expect(viewA.state.doc.toString()).toBe("hello world");
    expect(viewB.state.doc.toString()).toBe("hello world");

    // Edit through the secondary (B) too — proves bidirectional mirroring
    // before promotion, and gives B its own locally-typed edit to (maybe) undo.
    viewB.dispatch({ changes: { from: 11, insert: "!" } });
    expect(viewA.state.doc.toString()).toBe("hello world!");
    expect(viewB.state.doc.toString()).toBe("hello world!");

    // Simulate the primary (A) closing: promote B by reconfiguring its
    // historyCompartment to a live history() extension.
    viewB.dispatch({ effects: historyCompartmentB.reconfigure(history()) });

    // Assert the documented outcome: undo(viewB) immediately after promotion
    // does NOT revert the pre-promotion edits — the freshly (re)configured
    // history field starts with an empty undo stack, so undo() is a no-op
    // (returns false, doc unchanged) rather than reverting "!" or " world".
    const docBeforeUndo = viewB.state.doc.toString();
    const undoRan = undo(viewB);
    expect(undoRan).toBe(false);
    expect(viewB.state.doc.toString()).toBe(docBeforeUndo);
    expect(viewB.state.doc.toString()).toBe("hello world!");

    viewA.destroy();
    viewB.destroy();
  });
});
