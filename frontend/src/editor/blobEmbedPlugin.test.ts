import { describe, it, expect, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { blobEmbedPlugin, blobUrl, isImageName } from "./blobEmbedPlugin";
import { attachmentReference } from "../lib/useAttachmentUpload";

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views) v.destroy();
  views.length = 0;
});

function makeView(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [yamlFrontmatter({ content: markdown() }), blobEmbedPlugin] }),
  });
  views.push(view);
  return view;
}

function widgets(view: EditorView): HTMLElement[] {
  return Array.from(view.dom.querySelectorAll('[data-testid="blob-image-widget"]'));
}

describe("blobEmbedPlugin", () => {
  it("renders an image below an id embed with an image name", () => {
    const view = makeView("x\n![[jasper:blob/sha256-0123456789abcdef|shot.png]]\ny\n");
    const got = widgets(view);
    expect(got).toHaveLength(1);
    expect(got[0].dataset.blobId).toBe("sha256-0123456789abcdef");
    expect(got[0].querySelector("img")?.getAttribute("src")).toBe(blobUrl("sha256-0123456789abcdef"));
  });

  it("leaves a non-image embed, a link, and code alone", () => {
    const view = makeView("![[jasper:blob/sha256-0123456789abcdef|report.pdf]]\n[[jasper:blob/sha256-0123456789abcdef|shot.png]]\n`![[jasper:blob/sha256-0123456789abcdef|x.png]]`\n");
    expect(widgets(view)).toHaveLength(0);
  });

  it("knows image names", () => {
    expect(isImageName("a.PNG")).toBe(true);
    expect(isImageName("a.pdf")).toBe(false);
    expect(isImageName("sha256-00")).toBe(false);
  });
});

describe("attachmentReference", () => {
  it("writes an id embed when the upload carries a blob id, a path otherwise", () => {
    const base = { filename: "holiday photo.png", path: "attachments/holiday photo.png", is_image: true };
    expect(attachmentReference({ ...base, blob_id: "sha256-00ff" })).toBe("![[jasper:blob/sha256-00ff|holiday photo.png]]");
    expect(attachmentReference({ ...base, is_image: false, blob_id: "sha256-00ff" })).toBe("[[jasper:blob/sha256-00ff|holiday photo.png]]");
    expect(attachmentReference(base)).toBe("![holiday photo.png](attachments/holiday%20photo.png)");
  });
});
