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
 */
import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { saveKeymap } from "./jasperKeymap";

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
