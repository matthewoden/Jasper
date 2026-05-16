/**
 * jasperKeymap.test — verifies Cmd+S (Mod-s) keymap calls the onSave
 * callback and prevents default browser behavior. Plan 05-11 / EDIT-10.
 *
 * NOTE on platform detection: CM6 resolves "Mod-" to metaKey on Mac
 * (navigator.platform contains "Mac") and to ctrlKey everywhere else.
 * In the vitest happy-dom environment navigator.platform is empty (and
 * the CM6 browser-detection module caches this at load time), so "Mod-"
 * maps to ctrlKey here. This is consistent with CI/Linux behavior.
 * The Mac metaKey path is exercised by the production binary running on
 * macOS and by the Playwright E2E suite (Plan 05-12).
 *
 * Three tests verify:
 *   1. Ctrl-s triggers onSave and preventsDefault (the Mod-s path in test env)
 *   2. Ctrl-s triggers onSave on a second independent EditorView
 *   3. Plain 's' without a modifier does NOT trigger onSave
 *
 * Plan 07-24: JK-bold-italic tests verify toggleBold / toggleItalic CM6
 * commands (UAT-2 R1-4 — Cmd+B / Cmd+I were never bound to CM6 keymap).
 */
import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { saveKeymap, toggleBold, toggleItalic } from "./jasperKeymap";

describe("jasperKeymap / saveKeymap", () => {
  it("Ctrl-s triggers the onSave callback and prevents default (Mod-s in happy-dom)", () => {
    const onSave = vi.fn();
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "hi",
        extensions: [saveKeymap(onSave)],
      }),
    });
    try {
      // In happy-dom (navigator.platform=""), CM6 maps "Mod-" to ctrlKey.
      // On macOS (navigator.platform contains "Mac"), it maps to metaKey.
      const ev = new KeyboardEvent("keydown", {
        key: "s",
        code: "KeyS",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      view.contentDOM.dispatchEvent(ev);
      expect(onSave).toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(true);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("Ctrl-s also triggers onSave (cross-platform Mod- verification)", () => {
    const onSave = vi.fn();
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "hi",
        extensions: [saveKeymap(onSave)],
      }),
    });
    try {
      const ev = new KeyboardEvent("keydown", {
        key: "s",
        code: "KeyS",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      view.contentDOM.dispatchEvent(ev);
      expect(onSave).toHaveBeenCalled();
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("plain 's' keypress does NOT trigger onSave", () => {
    const onSave = vi.fn();
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "hi",
        extensions: [saveKeymap(onSave)],
      }),
    });
    try {
      const ev = new KeyboardEvent("keydown", {
        key: "s",
        code: "KeyS",
        bubbles: true,
        cancelable: true,
      });
      view.contentDOM.dispatchEvent(ev);
      expect(onSave).not.toHaveBeenCalled();
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan 07-24 / UAT-2 R1-4: toggleBold / toggleItalic CM6 commands
//
// NOTE on EditorView in happy-dom:
//   CM6's EditorView creates a contenteditable div that must be attached
//   to the document for selection/dispatch to work correctly.
// ─────────────────────────────────────────────────────────────────────────────

describe("JK-bold-italic — toggleBold / toggleItalic commands (UAT-2 R1-4)", () => {
  function makeView(doc: string, selFrom: number, selTo: number): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({ doc, selection: { anchor: selFrom, head: selTo } });
    return new EditorView({ state, parent });
  }

  it("JK-B-1: cursor only → inserts ** with cursor between", () => {
    const view = makeView("hello", 5, 5);
    try {
      const result = toggleBold(view);
      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe("hello****");
      // Cursor lands at position 7 (hello + ** = offset 7, before the closing **)
      expect(view.state.selection.main.from).toBe(7);
    } finally {
      view.destroy();
    }
  });

  it("JK-B-2: selection 'foo' → wraps to '**foo**'", () => {
    const view = makeView("foo bar", 0, 3);
    try {
      toggleBold(view);
      expect(view.state.doc.toString()).toBe("**foo** bar");
    } finally {
      view.destroy();
    }
  });

  it("JK-B-3: selection '**foo**' → strips to 'foo' (toggle off)", () => {
    const view = makeView("**foo** bar", 0, 7);
    try {
      toggleBold(view);
      expect(view.state.doc.toString()).toBe("foo bar");
    } finally {
      view.destroy();
    }
  });

  it("JK-B-4: selection 'foo' wrapped by ** → strips wrapper", () => {
    const view = makeView("**foo** bar", 2, 5);
    try {
      toggleBold(view);
      expect(view.state.doc.toString()).toBe("foo bar");
    } finally {
      view.destroy();
    }
  });

  it("JK-I-1: cursor only → inserts * with cursor between", () => {
    const view = makeView("hello", 5, 5);
    try {
      toggleItalic(view);
      expect(view.state.doc.toString()).toBe("hello**");
      // Cursor lands at position 6 (hello + * = offset 6, before closing *)
      expect(view.state.selection.main.from).toBe(6);
    } finally {
      view.destroy();
    }
  });

  it("JK-I-2: selection 'foo' → wraps to '*foo*'", () => {
    const view = makeView("foo bar", 0, 3);
    try {
      toggleItalic(view);
      expect(view.state.doc.toString()).toBe("*foo* bar");
    } finally {
      view.destroy();
    }
  });

  it("JK-I-3: selection '*foo*' → strips to 'foo'", () => {
    const view = makeView("*foo* bar", 0, 5);
    try {
      toggleItalic(view);
      expect(view.state.doc.toString()).toBe("foo bar");
    } finally {
      view.destroy();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan 07-36 (UAT-3 N7): JK-underline tests REMOVED. Cmd+U binding reverted —
// CM6 markdown editor renders raw source so <u>...</u> tags are visible literal
// characters, not an underline. See 07-CONTEXT.md D-51 REMOVED sub-section.
// ─────────────────────────────────────────────────────────────────────────────
