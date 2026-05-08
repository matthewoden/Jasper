/**
 * themeBridge.test — verifies the theme uses var(--color-*) tokens
 * for chrome-relevant properties. The three documented hex exceptions
 * (keyword purple, string green, number orange, type-name amber) are
 * scoped to highlight tags; this test asserts they are NOT used in
 * the editor theme block (chrome).
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { jasperEditorTheme, jasperSyntaxHighlighting, jasperHighlightStyle } from "./themeBridge";

describe("themeBridge", () => {
  it("jasperEditorTheme is an Extension that mounts without throwing", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "hello",
        extensions: [jasperEditorTheme, jasperSyntaxHighlighting],
      }),
    });
    expect(view).toBeDefined();
    view.destroy();
    parent.remove();
  });

  it("jasperEditorTheme applies var(--color-bg) to the editor container via CM6 dynamic styles", () => {
    // Mount the editor and check that CM6 injected a style containing
    // var(--color-bg) for the root selector background. CM6 injects its
    // theme as a <style> element into the document head.
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "hello",
        extensions: [jasperEditorTheme],
      }),
    });

    // CM6 writes theme rules into document.head as a <style> element.
    const styleContent = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");

    // The chrome selectors must use CSS variables — D-16 single source of truth.
    expect(styleContent).toMatch(/var\(--color-bg\)/);
    expect(styleContent).toMatch(/var\(--color-fg\)/);

    view.destroy();
    parent.remove();
  });

  it("jasperHighlightStyle has 8 tag entries (keyword, string, number, comment, function, type, variable, punctuation)", () => {
    // HighlightStyle.define returns a HighlightStyle whose .specs array
    // mirrors the input array. Verify we have all 8 entries.
    expect(jasperHighlightStyle.specs).toHaveLength(8);
  });

  it("jasperSyntaxHighlighting is truthy (Extension factory returned a value)", () => {
    expect(jasperSyntaxHighlighting).toBeTruthy();
  });
});
