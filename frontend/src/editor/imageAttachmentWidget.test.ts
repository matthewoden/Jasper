/**
 * imageAttachmentWidget.test.ts — vitest suite.
 *
 * Tests cover:
 *   - imageAttachmentPlugin: detects ![alt](attachments/x.png) and emits widget
 *   - imageAttachmentPlugin: ignores external images (https://...)
 *   - imageAttachmentPlugin: ignores non-attachment relative images
 *   - Widget placement: side:1 (BELOW the source line, source text stays editable)
 *   - Widget resolves URL via /api/v1/attachments/{noteId}/{filename}
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";

import { imageAttachmentPlugin, buildImageAttachmentDecorations } from "./imageAttachmentWidget";


function makeView(doc: string, noteId = "test-note-id"): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        yamlFrontmatter({ content: markdown() }),
        imageAttachmentPlugin(noteId),
      ],
    }),
  });
}

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views) v.destroy();
  views.length = 0;
  document.body.innerHTML = "";
});


describe("imageAttachmentWidget / imageAttachmentPlugin", () => {
  it("emits a widget for ![alt](attachments/x.png)", () => {
    const doc = "![my chart](attachments/chart.png)";
    const view = makeView(doc);
    views.push(view);

    const decos = buildImageAttachmentDecorations(view, "test-note-id");
    let hasWidget = false;
    const cursor = decos.iter();
    while (cursor.value !== null) {
      const spec = (cursor.value as unknown as { spec: { widget?: unknown; side?: number } }).spec;
      if (spec?.widget && spec?.side === 1) {
        hasWidget = true;
        break;
      }
      cursor.next();
    }
    expect(hasWidget).toBe(true);
  });

  it("does NOT emit a widget for external images (https://...)", () => {
    const doc = "![alt](https://example.com/image.png)";
    const view = makeView(doc);
    views.push(view);

    const decos = buildImageAttachmentDecorations(view, "test-note-id");
    let hasWidget = false;
    const cursor = decos.iter();
    while (cursor.value !== null) {
      const spec = (cursor.value as unknown as { spec: { widget?: unknown } }).spec;
      if (spec?.widget) {
        hasWidget = true;
        break;
      }
      cursor.next();
    }
    expect(hasWidget).toBe(false);
  });

  it("does NOT emit a widget for non-attachment relative images", () => {
    const doc = "![alt](images/photo.png)";
    const view = makeView(doc);
    views.push(view);

    const decos = buildImageAttachmentDecorations(view, "test-note-id");
    let hasWidget = false;
    const cursor = decos.iter();
    while (cursor.value !== null) {
      const spec = (cursor.value as unknown as { spec: { widget?: unknown } }).spec;
      if (spec?.widget) {
        hasWidget = true;
        break;
      }
      cursor.next();
    }
    expect(hasWidget).toBe(false);
  });

  it("emits widget at the END of the markdown image line (side:1 = after)", () => {
    const doc = "![photo](attachments/photo.jpg)";
    const view = makeView(doc);
    views.push(view);

    const decos = buildImageAttachmentDecorations(view, "test-note-id");
    const cursor = decos.iter();
    while (cursor.value !== null) {
      const spec = (cursor.value as unknown as { spec: { widget?: unknown; side?: number } }).spec;
      if (spec?.widget) {
        const lineEnd = view.state.doc.lineAt(0).to;
        expect(cursor.from).toBe(lineEnd);
        expect(cursor.to).toBe(lineEnd);
        expect(spec.side).toBe(1);
        break;
      }
      cursor.next();
    }
  });

  it("widget renders img src to /api/v1/attachments/{noteId}/{filename}", () => {
    const doc = "![alt](attachments/chart.png)";
    const view = makeView(doc, "note-uuid-456");
    views.push(view);

    const decos = buildImageAttachmentDecorations(view, "note-uuid-456");
    const cursor = decos.iter();
    while (cursor.value !== null) {
      const spec = (cursor.value as unknown as { spec: { widget?: { toDOM?: () => HTMLElement } } }).spec;
      if (spec?.widget && typeof spec.widget.toDOM === "function") {
        const dom = spec.widget.toDOM();
        const img = dom.querySelector("img");
        expect(img).not.toBeNull();
        expect(img?.src).toContain("/api/v1/attachments/note-uuid-456/");
        expect(img?.src).toContain("chart.png");
        break;
      }
      cursor.next();
    }
  });
});
