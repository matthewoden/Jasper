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
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { saveKeymap, toggleBold, toggleItalic, listEnterCommand } from "./jasperKeymap";

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


/**
 * listEnterCommand tests — LE series.
 *
 * LE-1: NON-EMPTY nested task → returns false (falls through to markdown handler)
 * LE-2: EMPTY top-level task `- [ ] ` → clears marker in place, returns true (no \n\n)
 * LE-3: EMPTY top-level plain bullet `- ` → clears marker in place, returns true (no \n\n)
 * LE-4: EMPTY NESTED task `  - [ ] ` → de-indents to `- [ ] `, returns true
 * LE-5: EMPTY NESTED plain bullet `  - ` → de-indents to `- `, returns true
 * LE-6: DEEPLY NESTED task `    - [ ] ` → de-indents to `  - [ ] ` (one level only), returns true
 * LE-7: Press Enter TWICE on empty nested task → de-indents once, then clears in place
 * LE-8: NON-EMPTY nested bullet `  - some text` → returns false (falls through)
 * LE-11: multi-line `- [x] test\n- [ ] ` → clears second line in place, returns true (no \n\n)
 */
describe("listEnterCommand — nested-empty-item de-indent", () => {
  // Helper: create a view with the markdown language loaded (needed for indentUnit defaults)
  function makeListView(doc: string, cursorPos: number): EditorView {
    const parent = document.createElement("div");
    document.body.append(parent);
    return new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: cursorPos, head: cursorPos },
        extensions: [yamlFrontmatter({ content: markdown({ base: markdownLanguage }) })],
      }),
    });
  }

  it("LE-1: non-empty nested task → returns false (falls through)", () => {
    // `  - [ ] some text` — cursor at end of line
    const doc = "  - [ ] some text";
    const view = makeListView(doc, doc.length);
    try {
      const result = listEnterCommand(view);
      expect(result).toBe(false);
      expect(view.state.doc.toString()).toBe(doc); // unchanged
    } finally {
      view.destroy();
    }
  });

  it("LE-2: empty top-level task `- [ ] ` → clears marker in place, returns true (no \\n\\n)", () => {
    // No leading whitespace — top-level item: exit the list by clearing the
    // marker in place. Short-circuits CM6's broken insertNewlineContinueMarkup.
    const doc = "- [ ] ";
    const view = makeListView(doc, doc.length);
    try {
      const result = listEnterCommand(view);
      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe(""); // line cleared in place
      expect(view.state.doc.toString()).not.toContain("\n"); // no newline added
      expect(view.state.selection.main.from).toBe(0); // cursor at line start
    } finally {
      view.destroy();
    }
  });

  it("LE-3: empty top-level plain bullet `- ` → clears marker in place, returns true (no \\n\\n)", () => {
    const doc = "- ";
    const view = makeListView(doc, doc.length);
    try {
      const result = listEnterCommand(view);
      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe("");
      expect(view.state.doc.toString()).not.toContain("\n");
      expect(view.state.selection.main.from).toBe(0);
    } finally {
      view.destroy();
    }
  });

  it("LE-4: empty nested task `  - [ ] ` → de-indents to `- [ ] ` (marker preserved)", () => {
    // Two leading spaces (one indent unit = 2 spaces) → becomes `- [ ] `
    const doc = "  - [ ] ";
    const view = makeListView(doc, doc.length);
    try {
      const result = listEnterCommand(view);
      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe("- [ ] ");
      // Cursor should be at start of marker (position 0 after removing 2 leading spaces)
      expect(view.state.selection.main.from).toBe(0);
    } finally {
      view.destroy();
    }
  });

  it("LE-5: empty nested plain bullet `  - ` → de-indents to `- `", () => {
    const doc = "  - ";
    const view = makeListView(doc, doc.length);
    try {
      const result = listEnterCommand(view);
      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe("- ");
    } finally {
      view.destroy();
    }
  });

  it("LE-6: deeply nested task `    - [ ] ` → de-indents to `  - [ ] ` (one level only)", () => {
    // 4 leading spaces (2 indent units) → becomes 2 leading spaces (1 indent unit)
    const doc = "    - [ ] ";
    const view = makeListView(doc, doc.length);
    try {
      const result = listEnterCommand(view);
      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe("  - [ ] ");
    } finally {
      view.destroy();
    }
  });

  it("LE-7: two Enters on empty nested task de-indents once, then clears in place", () => {
    // First Enter: `  - [ ] ` → `- [ ] ` (de-indent)
    // Second Enter: `- [ ] ` → "" (top-level, clear in place, returns true)
    const doc = "  - [ ] ";
    const view = makeListView(doc, doc.length);
    try {
      // First Enter
      let result = listEnterCommand(view);
      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe("- [ ] ");
      // Update cursor to end of de-indented line
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      // Second Enter
      result = listEnterCommand(view);
      expect(result).toBe(true); // top-level, cleared in place
      expect(view.state.doc.toString()).toBe("");
    } finally {
      view.destroy();
    }
  });

  it("LE-8: non-empty nested bullet `  - some text` → returns false (falls through)", () => {
    const doc = "  - some text";
    const view = makeListView(doc, doc.length);
    try {
      const result = listEnterCommand(view);
      expect(result).toBe(false);
      expect(view.state.doc.toString()).toBe(doc); // unchanged
    } finally {
      view.destroy();
    }
  });

  it("LE-9: empty nested checked task `  - [x] ` → de-indents to `- [x] `", () => {
    const doc = "  - [x] ";
    const view = makeListView(doc, doc.length);
    try {
      const result = listEnterCommand(view);
      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe("- [x] ");
    } finally {
      view.destroy();
    }
  });

  it("LE-10: cursor in middle of line on empty nested task → still de-indents", () => {
    // Cursor is at position 5 (middle of `  - [ ] `) — the whole line is empty (no text after marker)
    const doc = "  - [ ] ";
    const view = makeListView(doc, 5);
    try {
      const result = listEnterCommand(view);
      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe("- [ ] ");
    } finally {
      view.destroy();
    }
  });

  it("LE-11: multi-line `- [x] test\\n- [ ] ` → clears second line in place, no \\n\\n", () => {
    // Cursor at the very end of the empty second item. Exiting must NOT insert
    // a blank line — the second line is cleared in place, leaving `- [x] test\n`.
    const doc = "- [x] test\n- [ ] ";
    const view = makeListView(doc, doc.length);
    try {
      const result = listEnterCommand(view);
      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe("- [x] test\n");
      expect(view.state.doc.toString()).not.toContain("\n\n");
    } finally {
      view.destroy();
    }
  });
});
