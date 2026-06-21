/**
 * taskCheckboxPlugin — clickable, position-stable, accessible task checkboxes
 * that coexist with livePreviewPlugin's marker hiding.
 *
 * Architecture:
 *   - CheckboxToggleAnnotation  — marks toggle transactions for updateListener
 *   - ToggleCheckboxEffect      — carries absolute TaskMarker.from position
 *   - checkboxTransactionExtender — exported no-op shim (see note below)
 *   - CheckboxWidget (WidgetType) — renders lucide-style SVG checkbox (no native <input>)
 *   - taskCheckboxPlugin (ViewPlugin) — builds decorations + handles mousedown/keydown
 *     + dispatches the char-flip on ToggleCheckboxEffect
 *
 * Note on transactionExtender:
 *   `@codemirror/state`'s transactionExtender API (`Pick<TransactionSpec,
 *   "effects" | "annotations">`) cannot produce document changes — only
 *   effects and annotations. The actual char flip is therefore dispatched
 *   from ViewPlugin.update (two transactions: effect tx → char-flip tx).
 *   CheckboxToggleAnnotation is on the char-flip tx so the updateListener
 *   detects it correctly. `checkboxTransactionExtender` is exported as a
 *   no-op shim so MarkdownEditor.tsx doesn't need to change its extensions array.
 *
 * Key decisions:
 *   - Reveal-on-cursor model (D-01): caret ON the task line → no widget emitted,
 *     raw "- [ ] " text is visible and editable. caret OFF the line → checkbox
 *     widget + bullet are rendered. Mirrors wikilinkPlugin.
 *   - D-02 REVERSED (user design decision): widget replace range covers ONLY the
 *     TaskMarker "[ ]" — [TaskMarker.from .. TaskMarker.to]. The leading "- " is
 *     left as normal list markup so livePreviewPlugin renders it as a bullet (•),
 *     and the TaskMarker's trailing space is left as a literal character so the
 *     gap before the text is preserved and the rendered width stays close to the
 *     raw "[ ] " (no horizontal jump when the line toggles to raw). The widget
 *     span is `3ch` wide — exactly the raw "[ ]" it replaces — with the icon
 *     centered inside. This gives the "• ☐ text" Obsidian-style layout.
 *     Corollary: Backspace atomicity only covers the small [ ] range, not the full
 *     "- [ ] " prefix — fixing the Backspace-deletes-whole-prefix bug.
 *   - Lucide-style SVG icons (user design decision): unchecked = Square (rounded rect),
 *     checked = SquareCheck (rounded rect + check path). Built via createElementNS,
 *     NOT via lucide-react imports (CM6 WidgetType produces plain DOM, not React).
 *     SVG path data extracted from lucide-react v0.460.0 source.
 *   - Uses Task/TaskMarker lezer nodes (GFM)
 *   - Strikethrough on text only; checkbox glyph stays visible
 *   - StateEffect dispatch — position resolved at transaction time
 *   - ignoreEvent() returns false so clicks reach eventHandlers
 *   - data-pos on the widget is always TaskMarker.from (the '[' position)
 *     so the char-flip dispatch targets the correct bracket regardless of range.
 *
 * Security: SVG built via createElementNS only (no innerHTML); data-pos
 * parsed with parseInt + isNaN guard; '[' bracket verified before char-flip.
 *
 * Extension array order: checkboxTransactionExtender → taskCheckboxPlugin
 *   → livePreviewPlugin
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
    path.setAttribute("stroke", "#fff"); // intentional fixed color per UI-SPEC
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
    span.setAttribute("tabIndex", "-1"); // D-04: out of DOM tab order; toggle still works via editor-level keydown handler
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
  const cursorLines = computeCursorLines(view); // D-01: identify cursor-occupied lines
  const tree = syntaxTree(view.state);

  interface Entry {
    markerFrom: number; // start of replace range: TaskMarker.from (D-02 reversed)
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

        // D-01 reveal: skip widget when cursor is on this task line so raw text is editable
        const lineNum = view.state.doc.lineAt(node.from).number;
        if (cursorLines.has(lineNum)) return;

        const stateChar = view.state.doc.sliceString(node.from + 1, node.from + 2);
        const checked = stateChar !== " ";
        const taskNode = node.node.parent; // Task is direct parent of TaskMarker
        if (!taskNode) return;

        // D-02 REVERSED: widget replace range covers ONLY "[ ] " (TaskMarker + trailing space)
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
    // toggles between raw and widget. D-02: ListMark "- " stays a bullet.
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
        // UI-SPEC a11y: Space/Enter on focused checkbox span dispatches toggle
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
