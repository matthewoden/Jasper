/**
 * taskCheckboxPlugin — clickable, position-stable, accessible task checkboxes
 * that coexist with livePreviewPlugin's marker hiding.
 *
 * Architecture:
 *   - CheckboxToggleAnnotation  — marks toggle transactions for updateListener
 *   - ToggleCheckboxEffect      — carries absolute TaskMarker.from position
 *   - checkboxTransactionExtender — exported no-op shim (see note below)
 *   - CheckboxWidget (WidgetType) — renders <button role="checkbox"> with SVG checkmark
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
 *     widget replaces the full "- [ ] " prefix (D-02). Mirrors wikilinkPlugin.
 *   - Widget replace range covers ListMark + space + TaskMarker + trailing space
 *     (D-02): [ListMark.from .. TaskMarker.to + 1]. Ordered-list fallback uses
 *     TaskMarker.from if ListMark cannot be located via getChild("ListMark").
 *   - Uses Task/TaskMarker lezer nodes (GFM)
 *   - Strikethrough on text only; checkbox glyph stays visible
 *   - StateEffect dispatch — position resolved at transaction time
 *   - ignoreEvent() returns false so clicks reach eventHandlers
 *   - data-pos on the widget button is always TaskMarker.from (the '[' position)
 *     so the char-flip dispatch targets the correct bracket regardless of D-02
 *     range widening.
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
    const btn = document.createElement("button");
    btn.className = "cm-task-checkbox";
    btn.setAttribute("role", "checkbox");
    btn.setAttribute("aria-checked", this.checked ? "true" : "false");
    btn.setAttribute("aria-label", "Toggle task");
    btn.setAttribute("tabIndex", "0");
    btn.setAttribute("data-pos", String(this.markerPos));

    if (this.checked) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 10 8");
      svg.setAttribute("width", "10");
      svg.setAttribute("height", "8");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "#fff"); // intentional fixed color per UI-SPEC
      svg.setAttribute("stroke-width", "2");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      poly.setAttribute("points", "1.5,4 4,6.5 8.5,1.5");
      svg.appendChild(poly);
      btn.appendChild(svg);
    }

    return btn;
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
    markerFrom: number; // start of replace range (ListMark.from per D-02, or fallback)
    markerTo: number;   // end of TaskMarker (exclusive: markerTo+1 covers trailing space)
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

        // D-02: widen replace range to cover the full "- [ ] " prefix (ListMark + TaskMarker)
        // Lezer tree: BulletList > ListItem > [ListMark, Task > TaskMarker]
        const listItemNode = taskNode.parent;
        const listMarkNode = listItemNode?.getChild("ListMark");
        // Fallback to TaskMarker.from if ListMark not found (ordered-list A5 graceful degrade)
        const markerFrom = listMarkNode ? listMarkNode.from : node.from;

        entries.push({
          markerFrom,
          markerTo: node.to,
          taskTo: taskNode.to,
          checked,
          markerPos: node.from, // data-pos must stay = TaskMarker.from for click handler
        });
      },
    });
  }

  // RangeSetBuilder requires ascending from order
  entries.sort((a, b) => a.markerFrom - b.markerFrom);

  for (const { markerFrom, markerTo, taskTo, checked, markerPos } of entries) {
    // Replace widget: [markerFrom .. markerTo+1] — covers "- [ ] " or "1. [ ] " prefix (D-02)
    builder.add(
      markerFrom,
      markerTo + 1,
      Decoration.replace({ widget: new CheckboxWidget(checked, markerPos) }),
    );
    // Strikethrough mark: [markerTo+1 .. taskTo] — text only
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
        const btn = target.closest("button[data-pos]") as HTMLElement | null;
        if (!btn) return false;
        const pos = parseInt(btn.getAttribute("data-pos") ?? "", 10);
        if (isNaN(pos)) return false;
        view.dispatch({ effects: ToggleCheckboxEffect.of(pos) });
        e.preventDefault(); // prevent cursor placement on click
        return true;
      },
      keydown(e: KeyboardEvent, view: EditorView) {
        // UI-SPEC a11y: Space/Enter on focused checkbox button dispatches toggle
        if (e.key !== " " && e.key !== "Enter") return false;
        const target = e.target as HTMLElement;
        const btn = target.closest("button[data-pos]") as HTMLElement | null;
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
