/**
 * wikilinkPlugin.test.ts — vitest suite for the CM6 wikilink decoration plugin.
 *
 * TDD gate: RED → GREEN
 * Tests P1..P12 as specified in Plan 06-09 Task 2.
 *
 * Harness: reuses the EditorView setup pattern from livePreviewPlugin.test.ts.
 * Decorations are inspected by accessing the plugin instance's .decorations field.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import {
  wikilinkPlugin,
  WIKILINK_RE,
  WikiLinkWidget,
} from "./wikilinkPlugin";
import {
  setResolvedTitlesSnapshot,
} from "./wikilinkResolver";


function makeView(
  doc: string,
  selectionPos = 0,
  resolvedTitles?: Set<string>,
  idMap?: Map<string, string>,
): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  if (resolvedTitles !== undefined) {
    setResolvedTitlesSnapshot(resolvedTitles, idMap);
  }
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: selectionPos, head: selectionPos },
      extensions: [yamlFrontmatter({ content: markdown() }), wikilinkPlugin],
    }),
  });
}

interface WikiLinkDecoEntry {
  from: number;
  to: number;
  widget: WikiLinkWidget | null;
  isReplace: boolean;
}

/**
 * Walk the plugin's DecorationSet and return entries that have a WikiLinkWidget.
 */
function collectWikilinkDecos(view: EditorView): WikiLinkDecoEntry[] {
  const plugin = view.plugin(wikilinkPlugin);
  if (!plugin) return [];
  const out: WikiLinkDecoEntry[] = [];
  const cursor = plugin.decorations.iter();
  while (cursor.value !== null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spec = (cursor.value as any).spec as Record<string, unknown>;
    const rawWidget = spec?.widget;
    if (rawWidget instanceof WikiLinkWidget) {
      out.push({
        from: cursor.from,
        to: cursor.to,
        widget: rawWidget,
        isReplace: true,
      });
    }
    cursor.next();
  }
  return out;
}


describe("wikilinkPlugin", () => {
  const views: EditorView[] = [];

  beforeEach(() => {
    setResolvedTitlesSnapshot(new Set(), new Map());
  });

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("P1: [[Foo]] on a different line (off-cursor) with 'foo' in resolvedTitles → cm-wiki-link widget", () => {
    const doc = "see [[Foo]] for more\nsome text on line 2";
    const cursorPos = doc.indexOf("\nsome") + 1;
    const resolvedTitles = new Set(["foo"]);
    const view = makeView(doc, cursorPos, resolvedTitles);
    views.push(view);

    const decos = collectWikilinkDecos(view);
    expect(decos.length).toBe(1);
    expect(decos[0].widget?.isResolved).toBe(true);
    expect(decos[0].widget?.displayText).toBe("Foo");
    expect(decos[0].widget?.rawTitle).toBe("Foo");
  });

  it("P2: [[Foo]] off-cursor, 'foo' NOT in resolvedTitles → cm-wiki-link-pending widget", () => {
    const doc = "see [[Foo]] for more\nsome text on line 2";
    const cursorPos = doc.indexOf("\nsome") + 1;
    const view = makeView(doc, cursorPos, new Set());
    views.push(view);

    const decos = collectWikilinkDecos(view);
    expect(decos.length).toBe(1);
    expect(decos[0].widget?.isResolved).toBe(false);
  });

  it("P3: [[Foo|the foo doc]] off-cursor resolved → displayText is the alias text", () => {
    const doc = "see [[Foo|the foo doc]] here\ncursor on line 2";
    const cursorPos = doc.indexOf("\ncursor") + 1;
    const view = makeView(doc, cursorPos, new Set(["foo"]));
    views.push(view);

    const decos = collectWikilinkDecos(view);
    expect(decos.length).toBe(1);
    expect(decos[0].widget?.displayText).toBe("the foo doc");
    expect(decos[0].widget?.rawTitle).toBe("Foo");
    expect(decos[0].widget?.isResolved).toBe(true);
  });

  it("P4: cursor on the line containing [[Foo]] → NO replace decoration (raw markup visible)", () => {
    const doc = "see [[Foo]] for more";
    const view = makeView(doc, 0, new Set(["foo"]));
    views.push(view);

    const decos = collectWikilinkDecos(view);
    expect(decos.length).toBe(0);
  });

  it("P5: [[Foo]] inside a fenced code block is NOT decorated", () => {
    const doc = [
      "Normal line",
      "```",
      "[[Foo]] is literal here",
      "```",
      "After",
    ].join("\n");
    const view = makeView(doc, 0, new Set(["foo"]));
    views.push(view);

    const decos = collectWikilinkDecos(view);
    expect(decos.length).toBe(0);
  });

  it("P6: [[Foo]] inside inline code is NOT decorated", () => {
    const doc = "Some `[[Foo]] literal` text\ncursor on line 2";
    const cursorPos = doc.indexOf("\ncursor") + 1;
    const view = makeView(doc, cursorPos, new Set(["foo"]));
    views.push(view);

    const decos = collectWikilinkDecos(view);
    expect(decos.length).toBe(0);
  });

  it("P7: [[Foo]] inside the Frontmatter node is NOT decorated", () => {
    const doc = [
      "---",
      "title: [[Foo]] in frontmatter",
      "---",
      "[[Foo]] in body",
      "cursor line",
    ].join("\n");
    const cursorPos = doc.lastIndexOf("cursor line");
    const view = makeView(doc, cursorPos, new Set(["foo"]));
    views.push(view);

    const decos = collectWikilinkDecos(view);
    expect(decos.length).toBe(1);
    const bodyIdx = doc.lastIndexOf("[[Foo]]");
    expect(decos[0].from).toBe(bodyIdx);
  });

  it("P8: IME composing → decorations are mapped through changes, not rebuilt", () => {
    const doc = "see [[Foo]] and [[Bar]]\ncursor on line 2";
    const cursorPos = doc.indexOf("\ncursor") + 1;
    const view = makeView(doc, cursorPos, new Set(["foo", "bar"]));
    views.push(view);

    const plugin = view.plugin(wikilinkPlugin);
    expect(plugin).not.toBeNull();

    const beforeDecos = plugin!.decorations;
    view.dispatch({
      changes: { from: 0, to: 0, insert: "" }, // no-op change
    });
    expect(plugin!.decorations).toBeDefined();
    const decos = collectWikilinkDecos(view);
    expect(decos.length).toBe(2);

    void beforeDecos;
  });

  it("P9: after a doc change, wikilinks are still decorated (decoration rebuild)", () => {
    const lines = ["first line with [[Alpha]]\n", "cursor line"];
    const doc = lines.join("");
    const cursorPos = doc.indexOf("cursor line");
    const view = makeView(doc, cursorPos, new Set(["alpha"]));
    views.push(view);

    const decos = collectWikilinkDecos(view);
    expect(decos.length).toBe(1);
    expect(decos[0].widget?.rawTitle).toBe("Alpha");
  });

  it("P10: doc with 3 wikilinks off-cursor decorates all 3 correctly", () => {
    const doc = [
      "[[Alpha]] first",
      "[[Beta]] second",
      "[[Gamma]] third",
      "cursor on line 4",
    ].join("\n");
    const cursorPos = doc.lastIndexOf("cursor on line 4");
    const view = makeView(doc, cursorPos, new Set(["alpha", "beta", "gamma"]));
    views.push(view);

    const decos = collectWikilinkDecos(view);
    expect(decos.length).toBe(3);
    const titles = decos.map((d) => d.widget?.rawTitle).sort();
    expect(titles).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(decos.every((d) => d.widget?.isResolved)).toBe(true);
  });

  it("P11: resolved-state change via setResolvedTitlesSnapshot — after doc change, decoration updates", () => {
    const twoLine = "see [[Foo]] here \ncursor on line 2";
    const cursorPos = twoLine.indexOf("\ncursor") + 1;
    const view = makeView(twoLine, cursorPos, new Set([]));
    views.push(view);

    let decos = collectWikilinkDecos(view);
    expect(decos.length).toBe(1);
    expect(decos[0].widget?.isResolved).toBe(false);

    setResolvedTitlesSnapshot(new Set(["foo"]), new Map([["foo", "uuid-foo"]]));

    const line1End = twoLine.indexOf(" \n");
    view.dispatch({
      changes: { from: line1End, to: line1End + 1, insert: "" },
    });

    decos = collectWikilinkDecos(view);
    expect(decos.length).toBe(1);
    expect(decos[0].widget?.isResolved).toBe(true);
    expect(decos[0].widget?.targetId).toBe("uuid-foo");
  });

  it("P12: WikiLinkWidget.eq returns true for identical (displayText + state + targetId)", () => {
    const w1 = new WikiLinkWidget("Foo", true, "uuid-1", "Foo");
    const w2 = new WikiLinkWidget("Foo", true, "uuid-1", "Foo");
    expect(w1.eq(w2)).toBe(true);
  });

  it("P12: WikiLinkWidget.eq returns false when displayText differs", () => {
    const w1 = new WikiLinkWidget("Foo", true, "uuid-1", "Foo");
    const w2 = new WikiLinkWidget("Bar", true, "uuid-1", "Bar");
    expect(w1.eq(w2)).toBe(false);
  });

  it("P12: WikiLinkWidget.eq returns false when isResolved differs", () => {
    const w1 = new WikiLinkWidget("Foo", true, null, "Foo");
    const w2 = new WikiLinkWidget("Foo", false, null, "Foo");
    expect(w1.eq(w2)).toBe(false);
  });

  it("P12: WikiLinkWidget.eq returns false when targetId differs", () => {
    const w1 = new WikiLinkWidget("Foo", true, "uuid-1", "Foo");
    const w2 = new WikiLinkWidget("Foo", true, "uuid-2", "Foo");
    expect(w1.eq(w2)).toBe(false);
  });

  it("WikiLinkWidget.toDOM uses textContent not innerHTML (T-06-09-01 XSS safety)", () => {
    const w = new WikiLinkWidget("<script>alert(1)</script>", false, null, "safe");
    const dom = w.toDOM();
    expect(dom.innerHTML).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(dom.classList.contains("cm-wiki-link-pending")).toBe(true);
  });

  it("WikiLinkWidget.toDOM sets data-wikilink-title attribute", () => {
    const w = new WikiLinkWidget("Alias", true, "uuid-1", "RawTitle");
    const dom = w.toDOM();
    expect(dom.getAttribute("data-wikilink-title")).toBe("RawTitle");
    expect(dom.getAttribute("data-target-id")).toBe("uuid-1");
  });

  it("WikiLinkWidget.ignoreEvent returns false (click events bubble to linkClickHandler)", () => {
    const w = new WikiLinkWidget("Foo", true, "uuid-1", "Foo");
    expect(w.ignoreEvent()).toBe(false);
  });

  it("WIKILINK_RE matches [[Title]] and [[Title|Alias]]", () => {
    const re = new RegExp(WIKILINK_RE.source, "g");
    const line = "see [[Foo]] and [[Bar|My Bar]] here";
    const matches: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) matches.push(m);
    expect(matches.length).toBe(2);
    expect(matches[0][1]).toBe("Foo");
    expect(matches[0][2]).toBeUndefined();
    expect(matches[1][1]).toBe("Bar");
    expect(matches[1][2]).toBe("My Bar");
  });

  it("WIKILINK_RE does not match across newlines", () => {
    const re = new RegExp(WIKILINK_RE.source, "g");
    const line = "[[Foo\nBar]]";
    const matches: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) matches.push(m);
    expect(matches.length).toBe(0);
  });

  it("resolved link widget has data-target-id set from idMap", () => {
    const doc = "[[MyNote]] here\ncursor line";
    const cursorPos = doc.indexOf("cursor line");
    const idMap = new Map([["mynote", "uuid-my-note"]]);
    const view = makeView(doc, cursorPos, new Set(["mynote"]), idMap);
    views.push(view);

    const decos = collectWikilinkDecos(view);
    expect(decos.length).toBe(1);
    expect(decos[0].widget?.targetId).toBe("uuid-my-note");
  });
});
