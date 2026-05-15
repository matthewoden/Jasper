/**
 * dropIndicatorWidget.ts — Phase 7 Plan 20 / C3 (UAT #12).
 *
 * CM6 ViewPlugin that renders a blinking vertical caret at the cursor
 * position during a file dragover event, giving the user visual feedback
 * about where the dropped markdown will be inserted.
 *
 * Architecture (standard CM6 StateField provision pattern):
 *   - dropPosField:       StateField<number | null>  — holds the current drag position.
 *   - setDropPos:         StateEffect<number | null> — dispatched by the plugin on
 *                         dragover/dragleave/drop.
 *   - dropIndicatorPlugin:ViewPlugin                 — listens for dragover/dragleave/drop
 *                         on the editor's DOM element and renders a Decoration.widget
 *                         at posAtCoords({x, y}).
 *
 * NOTE: The StateField + StateEffect are exported SEPARATELY and must be
 * listed BEFORE dropIndicatorPlugin in the MarkdownEditor extensions array:
 *   extensions: [ ..., dropPosField, dropIndicatorPlugin ]
 *
 * This is the standard CM6 pattern. The non-standard `provide: () => [dropPosField]`
 * ViewPlugin option is NOT used — it caused confusion in historical reviews.
 *
 * If posAtCoords returns null (pointer outside document range, e.g. in
 * gutter or padding areas), the indicator hides rather than crashing or
 * rendering at a stale position (HALT-IF-INCONCLUSIVE GATE: acceptable v1
 * behavior).
 *
 * The plugin coexists with useAttachmentUpload's dragHandlers — both attach
 * listeners independently. The drop semantics (file insertion) are owned by
 * useAttachmentUpload; this plugin is purely visual feedback.
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

// ─────────────────────────────────────────────────────────────────────────────
// CSS animation — injected once at module load (same pattern as other widgets
// in this folder: imageAttachmentWidget.ts, externalImagePlugin.ts).
// Guards against double-injection if the module is HMR-reloaded.
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// DropCaretWidget — renders a thin blinking vertical bar at the drop position.
// ─────────────────────────────────────────────────────────────────────────────
class DropCaretWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-drop-indicator";
    el.setAttribute("aria-hidden", "true");
    return el;
  }

  ignoreEvent(): boolean {
    // The widget must not intercept events — all drag events go to the
    // plugin's DOM listener on the editor's root element.
    return true;
  }

  eq(other: DropCaretWidget): boolean {
    // All DropCaretWidget instances are identical in appearance.
    return other instanceof DropCaretWidget;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// StateEffect — dispatched by the plugin to set or clear the drop position.
// Exported so MarkdownEditor can include it in the extensions array check
// (and for testing).
// ─────────────────────────────────────────────────────────────────────────────
export const setDropPos = StateEffect.define<number | null>();

// ─────────────────────────────────────────────────────────────────────────────
// dropPosField — StateField that holds the current drag-hover position.
// Exported and listed BEFORE dropIndicatorPlugin in the extensions array so
// the plugin's first update() call can read it (field must be registered
// before the plugin that reads it).
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// dropIndicatorPlugin — CM6 ViewPlugin that manages DOM listeners and
// decorations for the drag-drop visual indicator.
//
// DOM listeners are attached to view.dom (the .cm-editor root) rather
// than view.contentDOM (.cm-content) because dragover fires on the entire
// editor surface, not just the editable content area.
// ─────────────────────────────────────────────────────────────────────────────
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

    // Arrow functions so `this` is the plugin instance, not the event target.
    private readonly onDragOver = (e: DragEvent) => {
      // Only react to file drag events (e.g. from the OS file picker).
      // Ignore other drag types (text selection, link drags).
      if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;

      // posAtCoords returns null when the pointer is outside the document
      // range (e.g. in the gutter, below the last line). In that case we
      // clear the indicator rather than rendering at a stale position.
      const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
      this.view.dispatch({ effects: setDropPos.of(pos) });
    };

    private readonly onDragLeave = () => {
      this.view.dispatch({ effects: setDropPos.of(null) });
    };

    private readonly onDrop = () => {
      this.view.dispatch({ effects: setDropPos.of(null) });
    };

    update(update: ViewUpdate) {
      // Rebuild decorations whenever the drop position changes.
      // dropPosField is registered in the same extensions array (before
      // this plugin) so it is always available via update.state.field().
      const pos = update.state.field(dropPosField);
      if (pos == null) {
        this.decorations = Decoration.none;
      } else {
        this.decorations = Decoration.set([
          Decoration.widget({
            widget: new DropCaretWidget(),
            // side: 0 renders the widget at the position (before the character).
            // This mimics a text cursor at the insertion point.
            side: 0,
          }).range(pos),
        ]);
      }
    }
  },
  {
    // Provide the decorations getter so CM6's view layer picks up our
    // decoration set and renders it. This is the standard pattern from
    // imageAttachmentWidget.ts and externalImagePlugin.ts.
    decorations: (v) => v.decorations,
  },
);
