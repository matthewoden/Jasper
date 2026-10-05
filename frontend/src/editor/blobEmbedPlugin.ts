/**
 * blobEmbedPlugin renders `![[jasper:blob/<id>|name.png]]` as an image below
 * its line, the way imageAttachmentWidget does for a path embed. Only names
 * with an image extension get a picture; other embeds keep their chip.
 *
 * The image is served by id (`/api/v1/blobs/<id>`), so where the file lives
 * does not matter. A missing blob shows the name with a note that it is
 * missing, as the path widget does.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

export const BLOB_EMBED_RE = /!\[\[jasper:blob\/(sha256-[0-9a-f]{16,64})(?:\|([^\]\n]+?))?\]\]/g;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif"]);

export function isImageName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTS.has(name.slice(dot).toLowerCase());
}

export function blobUrl(blobId: string): string {
  return `/api/v1/blobs/${encodeURIComponent(blobId)}`;
}

class BlobImageWidget extends WidgetType {
  constructor(readonly blobId: string, readonly name: string) {
    super();
  }

  eq(other: BlobImageWidget): boolean {
    return this.blobId === other.blobId && this.name === other.name;
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.style.cssText = [
      "display:block",
      "max-width:min(640px,calc(100% - 32px))",
      "margin:8px 0 12px 0",
      "border-radius:6px",
      "overflow:hidden",
      "background:var(--color-surface-subtle)",
      "aspect-ratio:3/2",
    ].join(";");
    container.dataset.testid = "blob-image-widget";
    container.dataset.blobId = this.blobId;

    const img = document.createElement("img");
    img.src = blobUrl(this.blobId);
    img.alt = this.name;
    img.style.cssText = "display:block;width:100%;height:auto;";
    img.onload = () => {
      container.style.aspectRatio = "";
    };
    img.onerror = () => {
      container.replaceChildren();
      container.style.aspectRatio = "";
      const missing = document.createElement("div");
      missing.style.cssText = "display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border:1px solid var(--color-border);border-radius:6px;font-size:14px;";
      missing.textContent = `${this.name} `;
      const muted = document.createElement("span");
      muted.style.color = "var(--color-muted)";
      muted.textContent = "(missing)";
      missing.appendChild(muted);
      container.appendChild(missing);
    };
    container.appendChild(img);
    return container;
  }

  get estimatedHeight(): number {
    return 200;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function insideCodeOrFrontmatter(view: EditorView, pos: number): boolean {
  let node = syntaxTree(view.state).resolveInner(pos);
  while (node) {
    const n = node.name;
    if (n === "FencedCode" || n === "CodeBlock" || n === "InlineCode" || n === "Frontmatter") return true;
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

export function buildBlobEmbedDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const re = new RegExp(BLOB_EMBED_RE.source, "g");
      let m: RegExpExecArray | null;
      let placed = false;
      while (!placed && (m = re.exec(line.text)) !== null) {
        const [, blobId, name] = m;
        const label = name ?? blobId;
        if (!isImageName(label) || insideCodeOrFrontmatter(view, line.from + m.index)) continue;
        builder.add(line.to, line.to, Decoration.widget({ widget: new BlobImageWidget(blobId, label), side: 1 }));
        placed = true;
      }
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const blobEmbedPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildBlobEmbedDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.view.composing) {
        this.decorations = this.decorations.map(u.changes);
        return;
      }
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildBlobEmbedDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
