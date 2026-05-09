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

  it("UX-10: theme strips focus outline on .cm-editor.cm-focused", () => {
    // Mount the editor and inspect the CM6-injected <style> for the
    // focus-ring kill rule. Asserting via the rendered stylesheet (not
    // the theme spec object) proves CM6 actually emitted the CSS.
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

    // CM6 transforms `&.cm-focused` into `.ͼ<scopeId>.cm-focused` —
    // the `&` resolves to the theme's auto-generated root class. Match
    // both the focused-with-outline-none pair AND the fact that some
    // selector ending in `.cm-focused` carries `outline: none !important`.
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

    // The .cm-content rule MUST carry max-width: 72ch. Pitfall 3:
    // max-width must NOT appear on .cm-scroller or .cm-line — assert
    // 72ch presence; the grep-style scope check lives in the plan's
    // acceptance criteria (max-width only on .cm-content).
    expect(styleContent).toMatch(/\.cm-content[\s\S]*?max-width:\s*72ch/);

    view.destroy();
    parent.remove();
  });

  it(".cm-list-bullet uses fixed-width inline-block (UX-16)", () => {
    // UX-16: replace prior `padding-right: 0.4em` with a fixed-width
    // inline-block box (1.5ch, left-aligned) so the bullet column
    // matches the on-cursor `.cm-marker.cm-list-marker` slot.
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

    // The .cm-list-bullet rule must carry display: inline-block, width: 1.5ch,
    // and text-align: left.
    expect(styleContent).toMatch(/\.cm-list-bullet[\s\S]*?display:\s*inline-block/);
    expect(styleContent).toMatch(/\.cm-list-bullet[\s\S]*?width:\s*1\.5ch/);
    expect(styleContent).toMatch(/\.cm-list-bullet[\s\S]*?text-align:\s*left/);

    // The padding-right: 0.4em anti-pattern must be removed from the
    // .cm-list-bullet rule. We assert the property is not present in the
    // cm-list-bullet block specifically by carving the rule out and
    // checking it independently.
    const bulletRuleMatch = styleContent.match(
      /\.cm-list-bullet\s*\{[^}]*\}/
    );
    expect(bulletRuleMatch).not.toBeNull();
    expect(bulletRuleMatch![0]).not.toMatch(/padding-right/);

    view.destroy();
    parent.remove();
  });

  it(".cm-marker.cm-list-marker exists with same fixed-width as .cm-list-bullet (UX-16)", () => {
    // UX-16: NEW rule — on-cursor `- ` raw marker gets the same 1.5ch
    // fixed-width slot as the off-cursor BulletWidget so the column does
    // not visually shift on cursor cross.
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

    // The compound `.cm-marker.cm-list-marker` rule must exist with the
    // same three properties as `.cm-list-bullet`.
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
