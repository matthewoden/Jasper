/**
 * imageAttachmentWidget.ts — Phase 7 Plan 10 / ATTACH-05 / D-26.
 *
 * CM6 ViewPlugin that detects markdown image syntax where the src starts with
 * `attachments/` and renders an inline image BELOW the source line.
 *
 * Key design choices (D-26, EDIT-01):
 *   - The widget is placed at `line.to` with `side: 1` (after line end).
 *     CM6 ViewPlugin constraint: `block: true` is NOT allowed in ViewPlugin
 *     decorations (CM6 throws "Block decorations may not be specified via plugins").
 *     Instead, the widget container uses CSS `display: block` to visually render
 *     on its own line below the source text. This matches the approach used by
 *     externalImagePlugin.ts (same constraint, same workaround).
 *   - The widget DOES NOT replace the source markdown — the `![alt](...)` text
 *     stays editable. EDIT-01 is preserved because this is an additive widget.
 *   - Unlike externalImagePlugin which uses Decoration.replace (hides the source),
 *     this plugin does NOT replace — it only ADDS an inline widget at line end.
 *
 * Image URL resolution (D-34):
 *   img.src = `/api/v1/attachments/${noteId}/${encodeURIComponent(filename)}`
 *   where filename = the part after "attachments/" in the markdown src.
 *
 * Loading placeholder (UI-SPEC §Surface 8, Pitfall 3 reflow mitigation):
 *   The container uses `aspect-ratio: 3 / 2` until the image's onload fires.
 *   This reserves space so CM6 doesn't reflow when the image loads.
 *
 * On error (UI-SPEC §Surface 8):
 *   Renders the filename + "(missing)" instead of the image.
 *
 * All colors via var(--color-*) tokens. No hex literals.
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

// Matches: ![alt text](attachments/filename.ext)
// Does NOT match external URLs.
const IMG_RE = /!\[([^\]]*)\]\((attachments\/[^)]+)\)/;

/**
 * InlineImageWidget — renders a single attachment image below its source line.
 * Placed via Decoration.widget({ block: true, side: 1 }) at line.to.
 */
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
    // UI-SPEC §Surface 8 — inline image widget container
    container.style.cssText = [
      "display:block",
      "max-width:min(640px,calc(100% - 32px))",
      "margin:8px 0 12px 0",
      "border-radius:6px",
      "overflow:hidden",
      "background:var(--color-surface-subtle)",
      // 3:2 aspect-ratio loading placeholder (Pitfall 3 reflow mitigation)
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
      // Clear the aspect-ratio placeholder after the image loads
      container.style.aspectRatio = "";
    };

    img.onerror = () => {
      // On error: swap to file-chip "missing" state
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
    return 200; // CM6 hint to reduce reflow
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * buildImageAttachmentDecorations — exported for testing.
 *
 * Walks the syntax tree for Image nodes whose src starts with "attachments/".
 * Places a widget at the END of the line containing the image markdown
 * (side:1 = after line content → renders after the source line, EDIT-01 safe).
 * Note: block:true is NOT used (CM6 ViewPlugin constraint — would throw
 * "Block decorations may not be specified via plugins"). CSS display:block
 * on the container achieves the visual block appearance instead.
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

        // Widget at END of line, side:1 → renders after the source line.
        // block:true is intentionally OMITTED — CM6 ViewPlugin constraint.
        // The widget's CSS `display:block` provides the visual block appearance.
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
 * imageAttachmentPlugin(noteId) — factory that returns a CM6 ViewPlugin.
 *
 * The noteId is captured in the plugin's closure so the widget knows which
 * attachment URL to construct. The factory is re-called when the active note
 * changes (MarkdownEditor adds it to the extensions array with the current
 * noteId from useTreeStore).
 */
export function imageAttachmentPlugin(noteId: string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildImageAttachmentDecorations(view, noteId);
      }
      update(u: ViewUpdate) {
        // IME guard (RESEARCH §Pitfall — composing state)
        if (u.view.composing) {
          this.decorations = this.decorations.map(u.changes);
          return;
        }
        if (
          u.docChanged ||
          u.viewportChanged ||
          syntaxTree(u.startState) !== syntaxTree(u.state)
        ) {
          this.decorations = buildImageAttachmentDecorations(u.view, noteId);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}
