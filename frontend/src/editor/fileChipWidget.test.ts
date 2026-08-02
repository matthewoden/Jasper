import { describe, it, expect, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";

import { fileChipPlugin, buildFileChipDecorations } from "./fileChipWidget";


function makeView(doc: string, noteId = "test-note-id"): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        yamlFrontmatter({ content: markdown() }),
        fileChipPlugin(noteId),
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


describe("fileChipWidget / fileChipPlugin", () => {
  it("emits a widget for [doc](attachments/x.pdf)", () => {
    const doc = "[report](attachments/report.pdf)";
    const view = makeView(doc);
    views.push(view);

    const decos = buildFileChipDecorations(view, "test-note-id");
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

  it("does NOT emit a widget for image attachments (![...](...) — those go to imageAttachmentPlugin)", () => {
    const doc = "![photo](attachments/photo.png)";
    const view = makeView(doc);
    views.push(view);

    const decos = buildFileChipDecorations(view, "test-note-id");
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

  it("does NOT emit a widget for external links", () => {
    const doc = "[link](https://example.com/page)";
    const view = makeView(doc);
    views.push(view);

    const decos = buildFileChipDecorations(view, "test-note-id");
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

  it("does NOT emit a widget for non-attachment local links", () => {
    const doc = "[note link](notes/some-note.md)";
    const view = makeView(doc);
    views.push(view);

    const decos = buildFileChipDecorations(view, "test-note-id");
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

  it("widget is placed at end of line with side:1 (block:true omitted per CM6 ViewPlugin constraint)", () => {
    const doc = "[report](attachments/report.pdf)";
    const view = makeView(doc);
    views.push(view);

    const decos = buildFileChipDecorations(view, "test-note-id");
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

  it("widget renders a link pointing to /api/v1/attachments/{noteId}/{filename}", () => {
    const doc = "[report](attachments/report.pdf)";
    const view = makeView(doc, "note-abc-123");
    views.push(view);

    const decos = buildFileChipDecorations(view, "note-abc-123");
    const cursor = decos.iter();
    while (cursor.value !== null) {
      const spec = (cursor.value as unknown as { spec: { widget?: { toDOM?: () => HTMLElement } } }).spec;
      if (spec?.widget && typeof spec.widget.toDOM === "function") {
        const dom = spec.widget.toDOM();
        const anchor = dom.tagName === "A" ? dom as HTMLAnchorElement : dom.querySelector("a");
        expect(anchor).not.toBeNull();
        expect(anchor?.href ?? anchor?.getAttribute("href")).toContain("attachments");
        break;
      }
      cursor.next();
    }
  });
});
