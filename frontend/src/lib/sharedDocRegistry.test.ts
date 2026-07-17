/**
 * sharedDocRegistry tests.
 *
 * Coverage (Task 1 — WS-10): N-view live mirroring via syncDispatch, with each
 * view keeping its own independent selection, and the syncAnnotation guard
 * that prevents re-broadcast loops.
 */
import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { registerView, syncAnnotation, syncDispatch, unregisterView } from "./sharedDocRegistry";

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
