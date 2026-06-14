/**
 * jasperKeymap.test — verifies Cmd+S (Mod-s) keymap calls onSave and prevents
 * default browser behavior; also verifies toggleBold / toggleItalic commands.
 *
 * Platform note: CM6 resolves "Mod-" to metaKey on Mac and ctrlKey elsewhere.
 * In the vitest happy-dom environment (navigator.platform is empty), "Mod-"
 * maps to ctrlKey — consistent with CI/Linux behavior.
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


describe("JK-bold-italic — toggleBold / toggleItalic commands", () => {
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


