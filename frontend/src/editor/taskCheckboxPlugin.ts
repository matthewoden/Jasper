/**
 * Clickable task checkboxes that coexist with livePreviewPlugin's marker hiding.
 *
 * The char flip is dispatched from ViewPlugin.update as a second transaction,
 * because transactionExtender can only add effects and annotations, never document
 * changes. checkboxTransactionExtender survives as a no-op shim so MarkdownEditor's
 * extensions array need not change.
 *
 * The widget replaces ONLY the TaskMarker "[ ]", not the leading "- " — that stays
 * real list markup so livePreviewPlugin still renders its bullet, and the trailing
 * space stays literal so the text does not jump when the line toggles back to raw.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  Annotation,
  EditorState,
  StateEffect,
  RangeSetBuilder,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { computeCursorLines } from "./livePreviewPlugin";


export const CheckboxToggleAnnotation = Annotation.define<true>();


export const ToggleCheckboxEffect = StateEffect.define<number>();


/**
 * checkboxTransactionExtender — exported no-op shim kept so MarkdownEditor.tsx
 * doesn't need to change its extensions array. The actual char flip is dispatched
 * from ViewPlugin.update (see module JSDoc for why transactionExtender can't do it).
 */
export const checkboxTransactionExtender = EditorState.transactionExtender.of(() => {
  return null;
});


/**
 * Build a lucide-style SVG element using createElementNS (no innerHTML).
 * Lucide icon specs extracted from lucide-react v0.460.0:
 *   Square:      <rect width="18" height="18" x="3" y="3" rx="2"/>
 *   SquareCheck: <rect width="18" height="18" x="3" y="3" rx="2"/>
 *                <path d="m9 12 2 2 4-4"/>
 */
function makeLucideSvg(checked: boolean): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  // Crop most of Lucide's built-in whitespace (the 18px rect sits in a 24px box)
  // so the visible square nearly fills the icon. The square is sized by the
  // parent span's height; width:auto keeps it square. (The span is wider than
  // the icon — `3ch` — to match the raw "[ ]" it replaces; the icon centers in
  // that slot.)
  svg.setAttribute("viewBox", "1 1 22 22");
  svg.setAttribute("width", "auto");
  svg.setAttribute("height", "100%");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", checked ? "var(--color-accent)" : "none");
  svg.setAttribute("stroke", checked ? "var(--color-accent)" : "var(--color-border)");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  // Rounded rect (the square outline / filled square)
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("width", "18");
  rect.setAttribute("height", "18");
  rect.setAttribute("x", "3");
  rect.setAttribute("y", "3");
  rect.setAttribute("rx", "2");
  svg.appendChild(rect);

  if (checked) {
    // White checkmark path centered in the filled square
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "m9 12 2 2 4-4");
    path.setAttribute("stroke", "#fff"); // intentional fixed color
    path.setAttribute("stroke-width", "2");
    svg.appendChild(path);
  }

  return svg;
}


class CheckboxWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly markerPos: number,
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.markerPos === this.markerPos;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-task-checkbox";
    span.setAttribute("role", "checkbox");
    span.setAttribute("aria-checked", this.checked ? "true" : "false");
    span.setAttribute("aria-label", "Toggle task");
    span.setAttribute("tabIndex", "-1"); // out of DOM tab order; toggle still works via editor-level keydown handler
    span.setAttribute("data-pos", String(this.markerPos));

    span.appendChild(makeLucideSvg(this.checked));

    return span;
  }

  ignoreEvent(): boolean {
    return false; // CRITICAL — let clicks reach eventHandlers
  }
}


function buildCheckboxDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const cursorLines = computeCursorLines(view); // identify cursor-occupied lines
  const tree = syntaxTree(view.state);

  interface Entry {
    markerFrom: number; // start of replace range: TaskMarker.from
    markerTo: number;   // end of replace range: TaskMarker.to + 1 (trailing space)
    taskTo: number;
    checked: boolean;
    markerPos: number;  // TaskMarker.from — stays as data-pos for the click handler
  }
  const entries: Entry[] = [];

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name !== "TaskMarker") return;

        // Reveal: skip widget when cursor is on this task line so raw text is editable
        const lineNum = view.state.doc.lineAt(node.from).number;
        if (cursorLines.has(lineNum)) return;

        const stateChar = view.state.doc.sliceString(node.from + 1, node.from + 2);
        const checked = stateChar !== " ";
        const taskNode = node.node.parent; // Task is direct parent of TaskMarker
        if (!taskNode) return;

        // Widget replace range covers ONLY "[ ] " (TaskMarker + trailing space)
        // livePreviewPlugin retains ownership of the ListMark "-" and renders it as a bullet.
        // This gives the Obsidian-style "• ☐ text" layout and fixes:
        //   - Backspace atomicity: only the "[ ]" range is atomic, not the full "- [ ] " prefix
        //   - Enter continuation: "- " stays in document, markdown() can parse and continue list
        entries.push({
          markerFrom: node.from,        // TaskMarker.from: the '[' position
          markerTo: node.to,            // TaskMarker.to: after ']'
          taskTo: taskNode.to,
          checked,
          markerPos: node.from,         // data-pos for click handler
        });
      },
    });
  }

  // RangeSetBuilder requires ascending from order
  entries.sort((a, b) => a.markerFrom - b.markerFrom);

  for (const { markerFrom, markerTo, taskTo, checked, markerPos } of entries) {
    // Replace widget: [markerFrom .. markerTo] — covers ONLY "[ ]", NOT the
    // trailing space. Leaving the space as a literal character (a) preserves the
    // gap between the checkbox and the text, and (b) keeps the rendered width
    // close to the raw "[ ] " width, so the text barely shifts when the line
    // toggles between raw and widget. ListMark "- " stays a bullet.
    builder.add(
      markerFrom,
      markerTo,
      Decoration.replace({ widget: new CheckboxWidget(checked, markerPos) }),
    );
    // Strikethrough mark: [markerTo+1 .. taskTo] — text only (skips the space).
    if (checked) {
      builder.add(
        markerTo + 1,
        taskTo,
        Decoration.mark({ class: "cm-task-text-checked" }),
      );
    }
  }

  return builder.finish();
}


export const taskCheckboxPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildCheckboxDecorations(view);
    }

    update(u: ViewUpdate) {
      // Detect ToggleCheckboxEffect and dispatch the char-flip as a separate transaction.
      // transactionExtender cannot produce document changes in @codemirror/state — see
      // module JSDoc. The char-flip transaction carries CheckboxToggleAnnotation for the
      // updateListener.
      for (const tr of u.transactions) {
        for (const e of tr.effects) {
          if (!e.is(ToggleCheckboxEffect)) continue;
          const markerFrom = e.value;
          // Defensive guard: verify '[' bracket before acting
          if (u.view.state.doc.sliceString(markerFrom, markerFrom + 1) !== "[") continue;
          // stateChar at markerFrom+1: ' ' = unchecked, any other char = checked
          const stateChar = u.view.state.doc.sliceString(markerFrom + 1, markerFrom + 2);
          const newChar = stateChar === " " ? "x" : " ";
          // Schedule dispatch after this update cycle completes
          Promise.resolve().then(() => {
            u.view.dispatch({
              changes: { from: markerFrom + 1, to: markerFrom + 2, insert: newChar },
              annotations: CheckboxToggleAnnotation.of(true),
            });
          });
        }
      }

      if (u.view.composing) {
        this.decorations = this.decorations.map(u.changes);
        return;
      }
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = buildCheckboxDecorations(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(e: MouseEvent, view: EditorView) {
        const target = e.target as HTMLElement;
        const btn = target.closest("span[data-pos]") as HTMLElement | null;
        if (!btn) return false;
        const pos = parseInt(btn.getAttribute("data-pos") ?? "", 10);
        if (isNaN(pos)) return false;
        view.dispatch({ effects: ToggleCheckboxEffect.of(pos) });
        e.preventDefault(); // prevent cursor placement on click
        return true;
      },
      keydown(e: KeyboardEvent, view: EditorView) {
        // a11y: Space/Enter on focused checkbox span dispatches toggle
        if (e.key !== " " && e.key !== "Enter") return false;
        const target = e.target as HTMLElement;
        const btn = target.closest("span[data-pos]") as HTMLElement | null;
        if (!btn) return false;
        const pos = parseInt(btn.getAttribute("data-pos") ?? "", 10);
        if (isNaN(pos)) return false;
        view.dispatch({ effects: ToggleCheckboxEffect.of(pos) });
        e.preventDefault();
        return true;
      },
    },
  },
);
