/**
 * sharedDocRegistry tests.
 *
 * Coverage (Task 1 — WS-10): N-view live mirroring via syncDispatch, with each
 * view keeping its own independent selection, and the syncAnnotation guard
 * that prevents re-broadcast loops.
 *
 * Coverage (Task 2 — Pitfall 2): single undo-history owner + promotion on
 * primary unregister, following the Plan 01 spike's documented outcome
 * (history does NOT survive Compartment.reconfigure — keep the closing
 * primary's EditorView alive off-DOM instead of destroying it).
 */
import { describe, expect, it, vi } from "vitest";
import { redo, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  getPrimaryView,
  historyExtensionFor,
  registerView,
  syncAnnotation,
  syncDispatch,
  unregisterView,
} from "./sharedDocRegistry";

/** Builds a bare EditorView wired through syncDispatch for the given noteId. */
function makeView(noteId: string, doc: string, isPrimary: boolean): EditorView {
  const ref: { view?: EditorView } = {};
  const view = new EditorView({
    state: EditorState.create({ doc }),
    dispatch: (tr) => syncDispatch(noteId, tr, ref.view!),
  });
  ref.view = view;
  registerView(noteId, view, isPrimary);
  return view;
}

/** Builds a view wired through syncDispatch AND historyExtensionFor (Task 2). */
function makeHistoryView(noteId: string, doc: string, isPrimary: boolean): EditorView {
  const ref: { view?: EditorView } = {};
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [historyExtensionFor(noteId, isPrimary)],
    }),
    dispatch: (tr) => syncDispatch(noteId, tr, ref.view!),
  });
  ref.view = view;
  registerView(noteId, view, isPrimary);
  return view;
}

describe("sharedDocRegistry — Task 1: registry + syncDispatch (N-view live mirroring)", () => {
  it("mirrors an insert from view A to view B while B's selection stays put", () => {
    const noteId = "note-1";
    const viewA = makeView(noteId, "hello", true);
    const viewB = makeView(noteId, "hello", false);

    // Give B a distinct selection before the mirrored edit arrives.
    viewB.dispatch({ selection: { anchor: 2, head: 2 } });
    expect(viewB.state.selection.main.anchor).toBe(2);

    viewA.dispatch({ changes: { from: 5, insert: " world" } });

    expect(viewA.state.doc.toString()).toBe("hello world");
    expect(viewB.state.doc.toString()).toBe("hello world");
    // B's own selection is untouched by the mirrored changes-only dispatch.
    expect(viewB.state.selection.main.anchor).toBe(2);

    unregisterView(noteId, viewA);
    unregisterView(noteId, viewB);
    viewA.destroy();
    viewB.destroy();
  });

  it("mirrors to a third view added later, and each view keeps independent selection", () => {
    const noteId = "note-2";
    const viewA = makeView(noteId, "abc", true);
    const viewB = makeView(noteId, "abc", false);
    const viewC = makeView(noteId, "abc", false);

    viewB.dispatch({ selection: { anchor: 1, head: 1 } });
    viewC.dispatch({ selection: { anchor: 3, head: 3 } });

    viewA.dispatch({ changes: { from: 3, insert: "d" } });

    expect(viewA.state.doc.toString()).toBe("abcd");
    expect(viewB.state.doc.toString()).toBe("abcd");
    expect(viewC.state.doc.toString()).toBe("abcd");
    expect(viewB.state.selection.main.anchor).toBe(1);
    expect(viewC.state.selection.main.anchor).toBe(3);

    unregisterView(noteId, viewA);
    unregisterView(noteId, viewB);
    unregisterView(noteId, viewC);
    viewA.destroy();
    viewB.destroy();
    viewC.destroy();
  });

  it("guards against re-broadcast loops via syncAnnotation (bounded, exactly-once foreign dispatch)", () => {
    const noteId = "note-3";
    const viewA = makeView(noteId, "x", true);
    const viewB = makeView(noteId, "x", false);

    const bDispatchSpy = vi.spyOn(viewB, "dispatch");

    viewA.dispatch({ changes: { from: 1, insert: "y" } });

    // Exactly one foreign dispatch reaches B for this one keystroke — if the
    // annotation guard were missing, B's own custom dispatch would re-forward
    // to A, which would re-forward back to B, looping.
    expect(bDispatchSpy).toHaveBeenCalledTimes(1);
    const forwardedSpec = bDispatchSpy.mock.calls[0][0] as { annotations?: unknown[] };
    expect(forwardedSpec.annotations).toHaveLength(1);
    expect(forwardedSpec.annotations?.[0]).toEqual(syncAnnotation.of(true));

    unregisterView(noteId, viewA);
    unregisterView(noteId, viewB);
    viewA.destroy();
    viewB.destroy();
  });

  it("does not mirror selection-only transactions (tr.changes.empty guard)", () => {
    const noteId = "note-4";
    const viewA = makeView(noteId, "z", true);
    const viewB = makeView(noteId, "z", false);

    const bDispatchSpy = vi.spyOn(viewB, "dispatch");
    viewA.dispatch({ selection: { anchor: 1, head: 1 } });
    expect(bDispatchSpy).not.toHaveBeenCalled();

    unregisterView(noteId, viewA);
    unregisterView(noteId, viewB);
    viewA.destroy();
    viewB.destroy();
  });
});

describe("sharedDocRegistry — Task 2: single undo-history owner + promotion-on-unregister (Pitfall 2)", () => {
  it("only the primary records history; undo/redo invoked via the primary affects the shared doc", () => {
    const noteId = "note-5";
    const viewA = makeHistoryView(noteId, "hello", true); // primary
    const viewB = makeHistoryView(noteId, "hello", false); // secondary — no local history()

    viewA.dispatch({ changes: { from: 5, insert: " world" } });
    expect(viewA.state.doc.toString()).toBe("hello world");
    expect(viewB.state.doc.toString()).toBe("hello world");

    // A secondary view has NO history() extension of its own; Undo/Redo for
    // the note must route through the registry's single primary timeline.
    const primary = getPrimaryView(noteId);
    expect(primary).toBe(viewA);
    expect(undo(primary!)).toBe(true);
    expect(viewA.state.doc.toString()).toBe("hello");
    expect(viewB.state.doc.toString()).toBe("hello");

    expect(redo(primary!)).toBe(true);
    expect(viewA.state.doc.toString()).toBe("hello world");
    expect(viewB.state.doc.toString()).toBe("hello world");

    unregisterView(noteId, viewA);
    unregisterView(noteId, viewB);
    viewA.destroy();
    viewB.destroy();
  });

  it("keeps the primary alive off-DOM on unregister while a survivor remains — undo still reflects the full pre-close history", () => {
    const noteId = "note-6";
    const viewA = makeHistoryView(noteId, "hello", true); // primary
    const viewB = makeHistoryView(noteId, "hello", false); // survivor

    viewA.dispatch({ changes: { from: 5, insert: " world" } });
    expect(viewB.state.doc.toString()).toBe("hello world");

    // Primary's pane "closes" — per the spike outcome, the registry keeps
    // viewA alive (does NOT destroy it, does NOT promote viewB via
    // Compartment.reconfigure, which would start viewB's history empty).
    unregisterView(noteId, viewA);

    const primaryAfter = getPrimaryView(noteId);
    expect(primaryAfter).toBe(viewA);

    // Undo still works and reflects the FULL history recorded before the
    // primary's pane closed (not a freshly-emptied stack).
    expect(undo(primaryAfter!)).toBe(true);
    expect(viewA.state.doc.toString()).toBe("hello");
    expect(viewB.state.doc.toString()).toBe("hello");

    // Full teardown: unregister the survivor, then release the kept-alive
    // primary for good (no other views remain at that point).
    unregisterView(noteId, viewB);
    unregisterView(noteId, viewA);
    expect(getPrimaryView(noteId)).toBeNull();
    viewA.destroy();
    viewB.destroy();
  });

  it("promotes a survivor via historyCompartment.reconfigure when the kept-alive primary is finally released with other views still open", () => {
    const noteId = "note-7";
    const viewA = makeHistoryView(noteId, "start", true); // primary
    const viewB = makeHistoryView(noteId, "start", false); // survivor 1
    const viewC = makeHistoryView(noteId, "start", false); // survivor 2

    // Primary's pane closes first — kept alive (first unregister is a no-op
    // for teardown purposes, per the spike outcome).
    unregisterView(noteId, viewA);
    expect(getPrimaryView(noteId)).toBe(viewA);

    // The app now decides to truly release the kept-alive primary (e.g. the
    // note is closed everywhere the original pane could reach it), while
    // OTHER views (B, C) are still open. There is no surviving history left
    // to protect for viewA specifically at this point, so a survivor is
    // promoted via the plain reconfigure path.
    unregisterView(noteId, viewA);

    const promoted = getPrimaryView(noteId);
    expect(promoted).not.toBeNull();
    expect(promoted).not.toBe(viewA);
    expect([viewB, viewC]).toContain(promoted);

    // Mirroring between the remaining views still works post-promotion.
    promoted!.dispatch({ changes: { from: 5, insert: "!" } });
    expect(viewB.state.doc.toString()).toBe("start!");
    expect(viewC.state.doc.toString()).toBe("start!");

    unregisterView(noteId, viewB);
    unregisterView(noteId, viewC);
    viewA.destroy();
    viewB.destroy();
    viewC.destroy();
  });
});
