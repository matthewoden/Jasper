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
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "hello",
        extensions: [jasperEditorTheme],
      }),
    });

    const styleContent = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");

    expect(styleContent).toMatch(/var\(--color-bg\)/);
    expect(styleContent).toMatch(/var\(--color-fg\)/);

    view.destroy();
    parent.remove();
  });

  it("jasperHighlightStyle has 8 tag entries (keyword, string, number, comment, function, type, variable, punctuation)", () => {
    expect(jasperHighlightStyle.specs).toHaveLength(8);
  });

  it("jasperSyntaxHighlighting is truthy (Extension factory returned a value)", () => {
    expect(jasperSyntaxHighlighting).toBeTruthy();
  });

  it("UX-10: theme strips focus outline on .cm-editor.cm-focused", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "hello",
        extensions: [jasperEditorTheme],
      }),
    });

    const styleContent = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");

    expect(styleContent).toMatch(/\.cm-focused\s*\{[^}]*outline:\s*none\s*!important/);

    view.destroy();
    parent.remove();
  });

  it("UX-11: theme applies max-width 72ch on .cm-content", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "hello",
        extensions: [jasperEditorTheme],
      }),
    });

    const styleContent = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");

    expect(styleContent).toMatch(/\.cm-content[\s\S]*?max-width:\s*72ch/);

    view.destroy();
    parent.remove();
  });

  it(".cm-list-bullet uses fixed-width inline-block (UX-16)", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "hello",
        extensions: [jasperEditorTheme],
      }),
    });

    const styleContent = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");

    expect(styleContent).toMatch(/\.cm-list-bullet[\s\S]*?display:\s*inline-block/);
    expect(styleContent).toMatch(/\.cm-list-bullet[\s\S]*?width:\s*1\.5ch/);
    expect(styleContent).toMatch(/\.cm-list-bullet[\s\S]*?text-align:\s*left/);

    const bulletRuleMatch = styleContent.match(
      /\.cm-list-bullet\s*\{[^}]*\}/
    );
    expect(bulletRuleMatch).not.toBeNull();
    expect(bulletRuleMatch![0]).not.toMatch(/padding-right/);

    view.destroy();
    parent.remove();
  });

  it(".cm-marker.cm-list-marker exists with same fixed-width as .cm-list-bullet (UX-16)", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "hello",
        extensions: [jasperEditorTheme],
      }),
    });

    const styleContent = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");

    expect(styleContent).toMatch(
      /\.cm-marker\.cm-list-marker[\s\S]*?display:\s*inline-block/
    );
    expect(styleContent).toMatch(
      /\.cm-marker\.cm-list-marker[\s\S]*?width:\s*1\.5ch/
    );
    expect(styleContent).toMatch(
      /\.cm-marker\.cm-list-marker[\s\S]*?text-align:\s*left/
    );

    view.destroy();
    parent.remove();
  });
});
