/**
 * SPIKE OUTCOME (Open Question 1): history resets on reconfigure — Plan 03 MUST
 * keep the closing primary's EditorView alive off-DOM (detached, not destroyed)
 * to retain history until the note fully closes.
 *
 * `Compartment.reconfigure` swaps in a brand-new `history()` extension instance;
 * CM6's `history()` stores its undo/redo stacks in its own private `StateField`,
 * which is (re)initialized empty the moment the field is added to the state via
 * reconfigure — there is no prior stack for it to inherit, because as far as the
 * field is concerned it has never existed on this state before. This spike
 * proves that empirically: edits recorded on the secondary view BEFORE promotion
 * are NOT undoable after `historyCompartment.reconfigure(history())` runs.
 *
 * Consequence for Plan 03 (Pattern 2 promotion): do NOT rely on a bare
 * Compartment.reconfigure to hand off undo history when the primary view's pane
 * closes. Instead, keep the original primary EditorView alive but detached from
 * the DOM (not destroyed) so its history StateField (and thus its undo stack)
 * survives; only destroy it once the note is fully closed everywhere. The
 * surviving secondary view continues mirroring edits via syncDispatch as today;
 * Undo/Redo keys on ANY view for the note route to the (possibly off-DOM)
 * primary's own dispatch, not to the promoted view's freshly-emptied history.
 *
 * This is the RESEARCH.md fallback (Open Question 1 / Assumption A2), now
 * confirmed as the actual required path rather than a defensive fallback.
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

    let viewA: EditorView;
    let viewB: EditorView;

    // Minimal local syncDispatch (per RESEARCH.md Pattern 1): apply the
    // transaction locally, then re-dispatch ONLY tr.changes (never selection)
    // to the other view, tagged so it does not re-broadcast.
    function dispatchA(tr: Transaction): void {
      viewA.update([tr]);
      if (tr.changes.empty || tr.annotation(syncAnnotation)) return;
      viewB.dispatch({ changes: tr.changes, annotations: [syncAnnotation.of(true)] });
    }
    function dispatchB(tr: Transaction): void {
      viewB.update([tr]);
      if (tr.changes.empty || tr.annotation(syncAnnotation)) return;
      viewA.dispatch({ changes: tr.changes, annotations: [syncAnnotation.of(true)] });
    }

    // View A is primary: owns history() in a Compartment.
    viewA = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [historyCompartmentA.of(history())],
      }),
      dispatch: dispatchA,
    });

    // View B is secondary: empty Compartment where history() would go.
    viewB = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [historyCompartmentB.of([])],
      }),
      dispatch: dispatchB,
    });

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
