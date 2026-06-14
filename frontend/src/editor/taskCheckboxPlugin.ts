/**
 * taskCheckboxPlugin — Phase 12 / Plan 01 (CHK-01..04).
 *
 * Provides clickable, position-stable, accessible task checkboxes that
 * coexist with livePreviewPlugin's marker hiding.
 *
 * Architecture (mirrors dropIndicatorWidget.ts):
 *   - CheckboxToggleAnnotation  — marks toggle transactions for updateListener
 *   - ToggleCheckboxEffect      — carries absolute TaskMarker.from position
 *   - checkboxTransactionExtender — exported shim (no-op in practice; see note below)
 *   - CheckboxWidget (WidgetType) — renders <button role="checkbox"> with SVG checkmark
 *   - taskCheckboxPlugin (ViewPlugin) — builds decorations + handles mousedown/keydown
 *                                       + dispatches the char-flip on ToggleCheckboxEffect
 *
 * Note on transactionExtender:
 *   The plan specified `EditorState.transactionExtender` for atomic char flip. However,
 *   `@codemirror/state@6.6.0`'s `transactionExtender` type signature is:
 *     `Pick<TransactionSpec, "effects" | "annotations"> | null`
 *   It can only return effects/annotations — NOT document changes. The CM6 implementation
 *   confirms this: `Transaction.create(state, tr.changes, ...)` uses the ORIGINAL tr.changes,
 *   discarding any changes returned by the extender. This is a CM6 API constraint, not a
 *   version bug. (Spike deviation — see SUMMARY.md § Deviations.)
 *
 *   The validated fallback (RESEARCH.md Pattern 2) is used instead: the ViewPlugin.update
 *   method detects ToggleCheckboxEffect and dispatches a second transaction with the doc
 *   change. This is two transactions (effect tx → char-flip tx) but the annotation
 *   `CheckboxToggleAnnotation` on the SECOND transaction still triggers the immediate flush
 *   in the updateListener correctly.
 *
 *   `checkboxTransactionExtender` is exported as a no-op shim so callers (MarkdownEditor.tsx)
 *   don't need to change. The annotation IS added to the char-flip transaction (not the
 *   effect transaction) by the ViewPlugin — updateListener detects it there.
 *
 * Key decisions (from 12-CONTEXT.md):
 *   D-01: Always-clickable widget — no on-cursor guard
 *   D-02: Broad GFM — taskCheckboxPlugin uses Task/TaskMarker lezer nodes
 *   D-04: Strikethrough text only; glyph stays visible
 *   D-05: StateEffect dispatch — position resolved at transaction time (in ViewPlugin.update)
 *   D-06: ignoreEvent() returns false so clicks reach eventHandlers
 *
 * Threat mitigations (T-12-01, T-12-02):
 *   - SVG built via createElementNS only (no innerHTML)
 *   - data-pos parsed with parseInt + isNaN guard
 *   - ViewPlugin.update validates '[' bracket before dispatching char-flip
 *
 * Extension array order (MarkdownEditor.tsx):
 *   checkboxTransactionExtender (no-op shim) → taskCheckboxPlugin → livePreviewPlugin
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


export const CheckboxToggleAnnotation = Annotation.define<true>();


export const ToggleCheckboxEffect = StateEffect.define<number>();


/**
 * checkboxTransactionExtender — exported no-op shim.
 *
 * Originally intended to add doc changes via EditorState.transactionExtender, but
 * CM6's transactionExtender API (`Pick<TransactionSpec, "effects" | "annotations">`)
 * does NOT support document changes — only effects and annotations. The actual char
 * flip is dispatched from ViewPlugin.update (see taskCheckboxPlugin below).
 *
 * This shim is kept so MarkdownEditor.tsx doesn't need to change its extensions array.
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
    return false; // CRITICAL — let clicks reach eventHandlers (D-06)
  }
}


function buildCheckboxDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);

  interface Entry {
    markerFrom: number;
    markerTo: number;
    taskTo: number;
    checked: boolean;
  }
  const entries: Entry[] = [];

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name !== "TaskMarker") return;
        const stateChar = view.state.doc.sliceString(node.from + 1, node.from + 2);
        const checked = stateChar !== " ";
        const taskNode = node.node.parent; // Task is direct parent of TaskMarker
        if (!taskNode) return;
        entries.push({
          markerFrom: node.from,
          markerTo: node.to,
          taskTo: taskNode.to,
          checked,
        });
      },
    });
  }

  // RangeSetBuilder requires ascending from order
  entries.sort((a, b) => a.markerFrom - b.markerFrom);

  for (const { markerFrom, markerTo, taskTo, checked } of entries) {
    // Replace widget: [markerFrom .. markerTo+1] — covers "[ ] " or "[x] " (marker + space)
    builder.add(
      markerFrom,
      markerTo + 1,
      Decoration.replace({ widget: new CheckboxWidget(checked, markerFrom) }),
    );
    // Strikethrough mark: [markerTo+1 .. taskTo] — text only (D-04)
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
      // This is the ViewPlugin.update fallback pattern (RESEARCH.md Pattern 2) because
      // transactionExtender cannot produce document changes in @codemirror/state@6.6.0.
      // The char-flip transaction carries CheckboxToggleAnnotation for the updateListener.
      for (const tr of u.transactions) {
        for (const e of tr.effects) {
          if (!e.is(ToggleCheckboxEffect)) continue;
          const markerFrom = e.value;
          // Defensive guard (T-12-02, RESEARCH Pitfall 3): verify '[' bracket
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
        e.preventDefault(); // prevent cursor placement (D-01)
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
