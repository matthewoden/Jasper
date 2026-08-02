/**
 * Renders a clickable file-chip below the source line for markdown links into
 * `attachments/` (excluding image links, which imageAttachmentWidget owns).
 *
 * The widget is at `line.to` with `side: 1`. block: true is prohibited in
 * ViewPlugin decorations; CSS display:inline-flex gives the same appearance while
 * the source text stays editable.
 *
 * User-supplied strings are set via textContent, never innerHTML.
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


const LINK_RE = /\[([^\]]*)\]\((attachments\/[^)]+)\)/;

/** Client-side extension → icon category map. Values correspond to Lucide icon names. */
const EXT_ICON_CATEGORY: Record<string, string> = {
  ".pdf": "FileText",
  ".mp4": "FileVideo",
  ".webm": "FileVideo",
  ".mov": "FileVideo",
  ".avi": "FileVideo",
  ".mkv": "FileVideo",
  ".mp3": "FileAudio",
  ".wav": "FileAudio",
  ".ogg": "FileAudio",
  ".m4a": "FileAudio",
  ".flac": "FileAudio",
  ".zip": "FileArchive",
  ".tar": "FileArchive",
  ".gz": "FileArchive",
  ".tgz": "FileArchive",
  ".7z": "FileArchive",
  ".rar": "FileArchive",
};


const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif"]);

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

function isImageFilename(filename: string): boolean {
  return IMAGE_EXTS.has(getExtension(filename));
}

function getIconCategory(filename: string): string {
  return EXT_ICON_CATEGORY[getExtension(filename)] ?? "File";
}

/** Renders a clickable chip below the [name](attachments/…) line. */
class FileChipWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly src: string,
    readonly noteId: string
  ) {
    super();
  }

  eq(other: FileChipWidget): boolean {
    return (
      this.label === other.label &&
      this.src === other.src &&
      this.noteId === other.noteId
    );
  }

  toDOM(): HTMLElement {
    const filename = this.src.replace(/^attachments\//, "");
    const iconCategory = getIconCategory(filename);
    const resolvedHref = `/api/v1/attachments/${encodeURIComponent(this.noteId)}/${encodeURIComponent(filename)}`;

    const anchor = document.createElement("a");
    anchor.href = resolvedHref;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    anchor.dataset.testid = "file-chip-widget";
    anchor.dataset.iconCategory = iconCategory;

    anchor.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "gap:8px",
      "padding:6px 12px",
      "margin:4px 0",
      "background:var(--color-surface)",
      "border:1px solid var(--color-border)",
      "border-radius:6px",
      "font-size:14px",
      "color:var(--color-fg)",
      "text-decoration:none",
      "cursor:pointer",
      "max-width:360px",
    ].join(";");

    const icon = document.createElement("span");
    icon.className = `cm-file-chip-icon cm-file-chip-icon-${iconCategory.toLowerCase()}`;
    icon.setAttribute("aria-hidden", "true");
    icon.style.cssText = "color:var(--color-muted);flex-shrink:0;font-size:16px;";
    const iconGlyph: Record<string, string> = {
      FileText: "📄",
      FileVideo: "🎬",
      FileAudio: "🎵",
      FileArchive: "📦",
      File: "📎",
    };
    icon.textContent = iconGlyph[iconCategory] ?? "📎";
    anchor.appendChild(icon);

    const nameEl = document.createElement("span");
    nameEl.className = "cm-file-chip-name";
    nameEl.style.cssText = [
      "overflow:hidden",
      "text-overflow:ellipsis",
      "white-space:nowrap",
      "font-size:14px",
      "color:var(--color-fg)",
    ].join(";");
    nameEl.textContent = filename;
    anchor.appendChild(nameEl);

    anchor.addEventListener("mouseenter", () => {
      anchor.style.background = "color-mix(in srgb, var(--color-muted) 8%, transparent)";
      anchor.style.borderColor = "color-mix(in srgb, var(--color-accent) 40%, transparent)";
    });
    anchor.addEventListener("mouseleave", () => {
      anchor.style.background = "var(--color-surface)";
      anchor.style.borderColor = "var(--color-border)";
    });

    return anchor;
  }

  get estimatedHeight(): number {
    return 32;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * buildFileChipDecorations — exported for testing.
 * Walks Link nodes whose href starts with "attachments/" and is not an image.
 * Emits a widget at line.to with side:1 (renders below the source line).
 */
export function buildFileChipDecorations(
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
        if (node.name !== "Link") return;

        const line = view.state.doc.lineAt(node.from);
        const lineText = line.text;

        const nodeOffsetInLine = node.from - line.from;
        if (nodeOffsetInLine > 0 && lineText[nodeOffsetInLine - 1] === "!") {
          return;
        }

        const m = LINK_RE.exec(lineText);
        if (!m) return;

        const [, label, src] = m;
        if (!src.startsWith("attachments/")) return;

        const filename = src.replace(/^attachments\//, "");
        if (isImageFilename(filename)) return;

        builder.add(
          line.to,
          line.to,
          Decoration.widget({
            widget: new FileChipWidget(label, src, noteId),
            side: 1,
          })
        );
      },
    });
  }

  return builder.finish();
}

/**
 * fileChipPlugin — factory returning a CM6 ViewPlugin for non-image attachment chips.
 *
 * Accepts a plain string or a mutable ref ({ current: string | null }) so the
 * plugin reads the current noteId at each decoration-build time. This lets the
 * same EditorView instance serve different notes without being recreated.
 */
export function fileChipPlugin(
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
        this.decorations = buildFileChipDecorations(view, getNoteId());
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
          this.decorations = buildFileChipDecorations(u.view, getNoteId());
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}
