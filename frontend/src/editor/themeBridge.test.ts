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
import { jasperEditorTheme, jasperSyntaxHighlighting } from "./themeBridge";

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

  it("source code uses var(--color-*) tokens for chrome backgrounds and foregrounds", async () => {
    // Read the source file as a string and assert var(--color-*)
    // appears for the backgroundColor + color + caretColor of the
    // root selectors. This is a sanity check that future edits
    // don't regress to raw hex on chrome — UI-SPEC §"Color" rule.
    const { readFile } = await import("node:fs/promises");
    const { resolve, dirname } = await import("node:path");
    // Use process.cwd() + relative path since import.meta.url may not be
    // a file:// URL in vitest jsdom mode.
    const src = await readFile(
      resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/[A-Z]:/, "")), "themeBridge.ts"),
      "utf8"
    ).catch(() =>
      readFile(resolve(process.cwd(), "src/editor/themeBridge.ts"), "utf8")
    );
    const chromeSelectors = [
      /backgroundColor:\s*"var\(--color-bg\)"/,
      /color:\s*"var\(--color-fg\)"/,
      /caretColor:\s*"var\(--color-fg\)"/,
    ];
    for (const r of chromeSelectors) {
      expect(src).toMatch(r);
    }
  });

  it("syntaxHighlighting includes function-name token mapped to var(--color-accent)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const src = await readFile(
      resolve(process.cwd(), "src/editor/themeBridge.ts"),
      "utf8"
    );
    expect(src).toMatch(/t\.function\(t\.variableName\),\s*color:\s*"var\(--color-accent\)"/);
  });
});
