/**
 * tableWidgetPlugin.test.ts — vitest suite for the GFM table widget.
 *
 * Covers: widget rendered when cursor is outside the table, raw markdown
 * (no widget) when cursor is inside the table, malformed-input fail-soft
 * (no throw), and cell inline-markdown rendering via createElement/textContent.
 */
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  buildTableDecorations,
  tableWidgetExtension,
  tableDecoField,
  TableWidget,
} from "./tableWidgetPlugin";
import type { SyntaxNode } from "@lezer/common";

const TABLE_DOC = `Some intro text.

| Header 1 | Header 2 |
| --- | --- |
| a | b |
| c | d |

Some outro text.`;

function makeState(doc: string, cursorPos: number): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: cursorPos },
    extensions: [markdown({ base: markdownLanguage }), tableWidgetExtension],
  });
}

/** Returns the decorations currently held by the table StateField. */
function decosFor(state: EditorState) {
  return state.field(tableDecoField);
}

function hasWidgetDecoration(state: EditorState): boolean {
  const decos = decosFor(state);
  let found = false;
  const cursor = decos.iter();
  while (cursor.value !== null) {
    if (cursor.value.spec?.widget !== undefined) found = true;
    cursor.next();
  }
  return found;
}

describe("tableWidgetPlugin", () => {
  it("renders a Decoration.replace block widget when the cursor is outside the table's range", () => {
    // cursor on "Some intro text." (line 1) — well outside the table
    const state = makeState(TABLE_DOC, 0);
    expect(hasWidgetDecoration(state)).toBe(true);
  });

  it("emits no widget (raw markdown) when the cursor is on any table line", () => {
    // find the position of the "| a | b |" line
    const lineStart = TABLE_DOC.indexOf("| a | b |");
    const state = makeState(TABLE_DOC, lineStart + 2);
    expect(hasWidgetDecoration(state)).toBe(false);
  });

  it("flips back to a widget once the cursor moves back outside the table (selection-only change)", () => {
    let state = makeState(TABLE_DOC, TABLE_DOC.indexOf("| a | b |") + 2);
    expect(hasWidgetDecoration(state)).toBe(false);

    const tr = state.update({ selection: { anchor: 0 } });
    state = tr.state;
    expect(hasWidgetDecoration(state)).toBe(true);
  });

  it("does not throw and falls back to raw text when toDOM encounters a malformed node", () => {
    // A node whose getChild/getChildren throw simulates a malformed/partial table.
    const throwingNode = {
      getChild() {
        throw new Error("malformed table node");
      },
      getChildren() {
        throw new Error("malformed table node");
      },
    } as unknown as SyntaxNode;

    const doc = EditorState.create({ doc: "| a | b |" }).doc;
    const widget = new TableWidget(throwingNode, doc, "| a | b |");

    let dom: HTMLElement | undefined;
    expect(() => {
      dom = widget.toDOM();
    }).not.toThrow();

    expect(dom).toBeDefined();
    expect(dom!.querySelector("table")).toBeNull();
    expect(dom!.textContent).toBe("| a | b |");
  });

  it("renders cell inline markdown via createElement/textContent (bold, code, link-as-text)", () => {
    const doc = `| Col |
| --- |
| **bold** \`code\` [t](https://example.com) |`;
    const cursorLines = new Set<number>(); // no cursor lines — force widget path
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage })],
    });
    const decos = buildTableDecorations(state, cursorLines);

    let widget: TableWidget | undefined;
    const cursor = decos.iter();
    while (cursor.value !== null) {
      if (cursor.value.spec?.widget instanceof TableWidget) {
        widget = cursor.value.spec.widget as TableWidget;
      }
      cursor.next();
    }
    expect(widget).toBeDefined();

    const dom = widget!.toDOM();
    expect(dom.querySelector("table")).not.toBeNull();
    expect(dom.querySelector("strong")?.textContent).toBe("bold");
    expect(dom.querySelector("code")?.textContent).toBe("code");
    const link = dom.querySelector("a");
    expect(link?.textContent).toBe("t");
    expect(link?.getAttribute("href")).toBe("https://example.com");

    // Security gate: no innerHTML assignment anywhere in the source (verified separately via grep).
  });
});
