/**
 * Renders an inline image BELOW the source line for markdown images whose src
 * starts with `attachments/`.
 *
 * The widget is placed at `line.to` with `side: 1`. block: true is prohibited in
 * ViewPlugin decorations (CM6 throws "Block decorations may not be specified via
 * plugins"); CSS display:block achieves the same appearance. Being additive rather
 * than a replace, the source text stays editable.
 *
 * The container holds `aspect-ratio: 3/2` until onload fires to prevent CM6 reflow.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";


const IMG_RE = /!\[([^\]]*)\]\((attachments\/[^)]+)\)/;

/** Renders a single attachment image below its source line. */
class InlineImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly noteId: string
  ) {
    super();
  }

  eq(other: InlineImageWidget): boolean {
    return (
      this.src === other.src &&
      this.alt === other.alt &&
      this.noteId === other.noteId
    );
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
    container.dataset.testid = "attachment-image-widget";

    const filename = this.src.replace(/^attachments\//, "");
    const resolvedSrc = `/api/v1/attachments/${encodeURIComponent(this.noteId)}/${encodeURIComponent(filename)}`;

    const img = document.createElement("img");
    img.src = resolvedSrc;
    img.alt = this.alt || "attachment image";
    img.style.cssText = "display:block;width:100%;height:auto;";
    img.dataset.testid = "attachment-image-loaded";

    img.onload = () => {
      container.style.aspectRatio = "";
    };

    img.onerror = () => {
      container.replaceChildren();
      container.style.aspectRatio = "";
      const missing = document.createElement("div");
      missing.style.cssText = [
        "display:inline-flex",
        "align-items:center",
        "gap:8px",
        "padding:6px 12px",
        "background:var(--color-surface)",
        "border:1px solid var(--color-border)",
        "border-radius:6px",
        "font-size:14px",
        "color:var(--color-fg)",
      ].join(";");
      missing.textContent = `${filename} `;
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

/**
 * buildImageAttachmentDecorations — exported for testing.
 * Walks Image nodes whose src starts with "attachments/".
 * Places a widget at line.to with side:1 (renders after the source line).
 */
export function buildImageAttachmentDecorations(
  view: EditorView,
  noteId: string
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name !== "Image") return;

        const line = view.state.doc.lineAt(node.from);
        const lineText = line.text;
        const m = IMG_RE.exec(lineText);
        if (!m) return;

        const [, alt, src] = m;
        if (!src.startsWith("attachments/")) return;

        builder.add(
          line.to,
          line.to,
          Decoration.widget({
            widget: new InlineImageWidget(src, alt, noteId),
            side: 1,
          })
        );
      },
    });
  }

  return builder.finish();
}

/**
 * imageAttachmentPlugin — factory returning a CM6 ViewPlugin.
 *
 * Accepts a plain string or a mutable ref ({ current: string | null }) so the
 * plugin reads the current noteId at decoration-build time. This handles note
 * navigation without recreating the EditorView.
 */
export function imageAttachmentPlugin(
  noteIdOrRef: string | { current: string | null }
) {
  const getNoteId = () =>
    typeof noteIdOrRef === "string"
      ? noteIdOrRef
      : (noteIdOrRef.current ?? "");

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildImageAttachmentDecorations(view, getNoteId());
      }
      update(u: ViewUpdate) {
        if (u.view.composing) {
          this.decorations = this.decorations.map(u.changes);
          return;
        }
        if (
          u.docChanged ||
          u.viewportChanged ||
          syntaxTree(u.startState) !== syntaxTree(u.state)
        ) {
          this.decorations = buildImageAttachmentDecorations(u.view, getNoteId());
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}
