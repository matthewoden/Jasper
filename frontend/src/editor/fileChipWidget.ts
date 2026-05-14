/**
 * fileChipWidget.ts — Phase 7 Plan 10 / ATTACH-06 / D-26.
 *
 * CM6 ViewPlugin that detects markdown link syntax where the href starts with
 * `attachments/` AND the link is NOT an image (no leading `!`) and renders a
 * clickable file-chip widget BELOW the source line.
 *
 * Key design choices (D-26, EDIT-01):
 *   - Widget at `line.to` with `side: 1` (after source line content).
 *     `block: true` is NOT used — CM6 ViewPlugin constraint forbids it.
 *     CSS `display: inline-flex` on the anchor provides visual block appearance.
 *   - The `[name](attachments/…)` text stays editable. EDIT-01 preserved.
 *
 * Click behavior: opens `/api/v1/attachments/{noteId}/{filename}` in a new tab
 * via `target="_blank" rel="noopener"`.
 *
 * Icon lookup (UI-SPEC §Surface 8, D-27):
 *   Based on file extension, using a client-side ext-to-icon category map.
 *   At upload time, the server returns `category`; at render time we only have
 *   the URL extension. The server's MIME-sniffed category and the client's
 *   extension-based category should agree for common file types.
 *
 * All colors via var(--color-*) tokens. No hex literals. T-7-29 mitigated
 * by using textContent (not innerHTML) for all user-supplied strings.
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

// Matches: [display text](attachments/filename.ext)
// MUST NOT match image links (![...](...)). The negative lookbehind `(?<!!)`
// ensures we only match plain links, not image links.
// We use a workaround since JS regex negative lookbehind is supported in
// modern browsers: check the character before the match ourselves.
const LINK_RE = /\[([^\]]*)\]\((attachments\/[^)]+)\)/;

/**
 * Extension-to-icon-category map (D-27 / UI-SPEC §Surface 8).
 * Client-side fallback when we only have the file extension.
 * Values correspond to Lucide icon names.
 */
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

// Image extensions — used to filter out image links that should be handled
// by imageAttachmentPlugin instead.
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

/**
 * FileChipWidget — renders a clickable chip below the [name](attachments/…) line.
 * UI-SPEC §Surface 8 §File-chip widget dimensions + colors.
 */
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

    // UI-SPEC §Surface 8 §File-chip widget
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

    // Icon placeholder (text-based icon since Lucide requires React)
    const icon = document.createElement("span");
    icon.className = `cm-file-chip-icon cm-file-chip-icon-${iconCategory.toLowerCase()}`;
    icon.setAttribute("aria-hidden", "true");
    icon.style.cssText = "color:var(--color-muted);flex-shrink:0;font-size:16px;";
    // Use a text glyph as a lightweight icon in the DOM widget
    const iconGlyph: Record<string, string> = {
      FileText: "📄",
      FileVideo: "🎬",
      FileAudio: "🎵",
      FileArchive: "📦",
      File: "📎",
    };
    icon.textContent = iconGlyph[iconCategory] ?? "📎";
    anchor.appendChild(icon);

    // Filename label (truncated via CSS)
    const nameEl = document.createElement("span");
    nameEl.className = "cm-file-chip-name";
    nameEl.style.cssText = [
      "overflow:hidden",
      "text-overflow:ellipsis",
      "white-space:nowrap",
      "font-size:14px",
      "color:var(--color-fg)",
    ].join(";");
    nameEl.textContent = filename; // textContent is XSS-safe (T-7-29)
    anchor.appendChild(nameEl);

    // Hover style via mouseenter/mouseleave (can't use :hover in JS-created DOM)
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
    return 32; // one chip row
  }

  ignoreEvent(): boolean {
    return false; // allow click to propagate
  }
}

/**
 * buildFileChipDecorations — exported for testing.
 *
 * Walks the syntax tree for Link nodes (NOT Image nodes) whose href starts
 * with "attachments/" and the file extension is NOT an image. Emits a block
 * widget at line.to with side:1 (below the source line).
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

        // Check: must be a plain link (NOT preceded by ! which makes it an Image)
        // The Image node in lezer-markdown encompasses the entire ![alt](src),
        // so if node.name === "Link" it's already not an image syntax link.
        // But we also need to check the character just before the [ in the line
        // to be sure.
        const nodeOffsetInLine = node.from - line.from;
        if (nodeOffsetInLine > 0 && lineText[nodeOffsetInLine - 1] === "!") {
          return; // This is part of an Image syntax — skip
        }

        const m = LINK_RE.exec(lineText);
        if (!m) return;

        const [, label, src] = m;
        if (!src.startsWith("attachments/")) return;

        // Skip images — handled by imageAttachmentPlugin
        const filename = src.replace(/^attachments\//, "");
        if (isImageFilename(filename)) return;

        // Widget at END of line, side:1. block:true intentionally OMITTED
        // (CM6 ViewPlugin constraint). CSS display:inline-flex provides visual
        // block appearance.
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
 * fileChipPlugin(noteId) — factory that returns a CM6 ViewPlugin for
 * non-image attachment link chips. Mirrors imageAttachmentPlugin's shape.
 */
export function fileChipPlugin(noteId: string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildFileChipDecorations(view, noteId);
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
          this.decorations = buildFileChipDecorations(u.view, noteId);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}
