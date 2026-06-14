/**
 * dropIndicatorWidget — CM6 ViewPlugin that renders a blinking caret at the
 * drop position during a file dragover, so the user can see where the markdown
 * will be inserted.
 *
 * StateField + StateEffect are exported separately and must be listed BEFORE
 * dropIndicatorPlugin in the extensions array:
 *   extensions: [ ..., dropPosField, dropIndicatorPlugin ]
 *
 * When posAtCoords returns null (pointer outside the document area), the
 * indicator hides rather than rendering at a stale position.
 *
 * This plugin is purely visual; drop insertion is handled by useAttachmentUpload.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";


if (typeof document !== "undefined" && !document.getElementById("cm-drop-indicator-style")) {
  const style = document.createElement("style");
  style.id = "cm-drop-indicator-style";
  style.textContent = `
    @keyframes cm-drop-blink {
      0%, 49.9% { opacity: 1; }
      50%, 100%  { opacity: 0; }
    }
    .cm-drop-indicator {
      display: inline-block;
      width: 2px;
      height: 1.2em;
      background: var(--color-accent);
      vertical-align: text-bottom;
      animation: cm-drop-blink 0.8s infinite;
      pointer-events: none;
      border-radius: 1px;
    }
  `;
  document.head.appendChild(style);
}


class DropCaretWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-drop-indicator";
    el.setAttribute("aria-hidden", "true");
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }

  eq(other: DropCaretWidget): boolean {
    return other instanceof DropCaretWidget;
  }
}


export function snapDropPos(
  rawPos: number,
  state: import("@codemirror/state").EditorState,
): number {
  const line = state.doc.lineAt(rawPos);
  const colInLine = rawPos - line.from;
  const lineLen = line.to - line.from;
  return colInLine < lineLen / 2 ? line.from : line.to;
}


export const setDropPos = StateEffect.define<number | null>();


export const dropPosField = StateField.define<number | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDropPos)) return e.value;
    }
    return value;
  },
});


export const dropIndicatorPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    private readonly view: EditorView;

    constructor(view: EditorView) {
      this.view = view;
      view.dom.addEventListener("dragover", this.onDragOver);
      view.dom.addEventListener("dragleave", this.onDragLeave);
      view.dom.addEventListener("drop", this.onDrop);
    }

    destroy() {
      this.view.dom.removeEventListener("dragover", this.onDragOver);
      this.view.dom.removeEventListener("dragleave", this.onDragLeave);
      this.view.dom.removeEventListener("drop", this.onDrop);
    }

    private readonly onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;

      const rawPos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (rawPos === null) {
        this.view.dispatch({ effects: setDropPos.of(null) });
        return;
      }
      const snapped = snapDropPos(rawPos, this.view.state);
      this.view.dispatch({ effects: setDropPos.of(snapped) });
    };

    private readonly onDragLeave = () => {
      this.view.dispatch({ effects: setDropPos.of(null) });
    };

    private readonly onDrop = () => {
      this.view.dispatch({ effects: setDropPos.of(null) });
    };

    update(update: ViewUpdate) {
      const pos = update.state.field(dropPosField);
      if (pos == null) {
        this.decorations = Decoration.none;
      } else {
        this.decorations = Decoration.set([
          Decoration.widget({
            widget: new DropCaretWidget(),
            side: 0,
          }).range(pos),
        ]);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);
