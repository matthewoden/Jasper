/**
 * frontmatterHidePlugin.test.ts — vitest suite for the frontmatter hide plugin.
 *
 * Verifies the YAML frontmatter block is hidden behind an invisible empty widget.
 * Cmd-Shift-Y toggles between hidden and raw YAML view.
 *
 * Hidden state: empty <span aria-hidden="true" style="display:none">
 * (no button, no chevron, no label text).
 */
import { describe, expect, it, afterEach } from "vitest";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { syntaxTree } from "@codemirror/language";
import {
  frontmatterHidePlugin,
  frontmatterHideExtension,
  toggleFrontmatterVisibility,
  frontmatterToggleKeymap,
  frontmatterBackspaceGuardKeymap,
  countTagsInFrontmatter,
} from "./frontmatterHidePlugin";
import { FRONTMATTER_NODE_NAME } from "./frontmatterPlugin";


function makeView(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        yamlFrontmatter({ content: markdown() }),
        frontmatterHideExtension,
      ],
    }),
  });
}

/** Count decorations in the plugin's decoration set. */
function countDecorations(view: EditorView): number {
  const plugin = view.plugin(frontmatterHidePlugin);
  if (!plugin) return 0;
  let count = 0;
  const cursor = plugin.decorations.iter();
  while (cursor.value !== null) {
    count++;
    cursor.next();
  }
  return count;
}

/** Check whether any decoration is a Decoration.replace (has a widget). */
function hasReplaceDecoration(view: EditorView): boolean {
  const plugin = view.plugin(frontmatterHidePlugin);
  if (!plugin) return false;
  const cursor = plugin.decorations.iter();
  while (cursor.value !== null) {
    if (cursor.value.spec?.widget !== undefined) {
      return true;
    }
    cursor.next();
  }
  return false;
}

/** Check whether any decoration is a line decoration (Decoration.line). */
function hasLineDecoration(view: EditorView): boolean {
  const plugin = view.plugin(frontmatterHidePlugin);
  if (!plugin) return false;
  const cursor = plugin.decorations.iter();
  while (cursor.value !== null) {
    if (cursor.from === cursor.to && cursor.value.spec?.class !== undefined) {
      return true;
    }
    cursor.next();
  }
  return false;
}

/**
 * Get the empty span DOM from the FrontmatterEmptyWidget (rendered into a temp span).
 * Returns the HTMLSpanElement produced by the widget's toDOM() method.
 */
function getEmptyWidgetSpan(view: EditorView): HTMLSpanElement | null {
  const plugin = view.plugin(frontmatterHidePlugin);
  if (!plugin) return null;
  const cursor = plugin.decorations.iter();
  while (cursor.value !== null) {
    if (cursor.value.spec?.widget !== undefined) {
      const el = cursor.value.spec.widget.toDOM();
      if (el instanceof HTMLSpanElement) return el;
    }
    cursor.next();
  }
  return null;
}


const DOC_WITH_TWO_TAGS = `---
tags: [foo, bar]
---
# Body
Paragraph.`;

const DOC_WITH_EMPTY_TAGS = `---
tags: []
---
# Body
Paragraph.`;

const DOC_NO_FRONTMATTER = `# Heading
Body paragraph.`;

const DOC_MALFORMED_NO_TAGS = `---
foo: bar
baz: qux
---
Body paragraph.`;

const DOC_WITH_BLOCK_TAGS = `---
tags:
  - alpha
  - beta
  - gamma
---
# Body`;


describe("frontmatterHidePlugin — hidden state (default)", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("doc with tags: [foo, bar] → single replace decoration (empty widget, no visible text)", () => {
    const view = makeView(DOC_WITH_TWO_TAGS);
    views.push(view);

    expect(hasReplaceDecoration(view)).toBe(true);

    const span = getEmptyWidgetSpan(view);
    expect(span).not.toBeNull();
    expect(span?.getAttribute("aria-hidden")).toBe("true");
    expect(span?.style.display).toBe("none");
    expect(span?.textContent).toBe("");
  });

  it("doc with tags: [] → replace decoration with empty span (no 'empty' label)", () => {
    const view = makeView(DOC_WITH_EMPTY_TAGS);
    views.push(view);

    expect(hasReplaceDecoration(view)).toBe(true);

    const span = getEmptyWidgetSpan(view);
    expect(span).not.toBeNull();
    expect(span?.getAttribute("aria-hidden")).toBe("true");
    expect(span?.style.display).toBe("none");
  });

  it("doc without frontmatter → no decorations, no error", () => {
    const view = makeView(DOC_NO_FRONTMATTER);
    views.push(view);

    expect(countDecorations(view)).toBe(0);
    expect(hasReplaceDecoration(view)).toBe(false);
  });

  it("doc with frontmatter but no tags key → empty span widget (no tag count label)", () => {
    const view = makeView(DOC_MALFORMED_NO_TAGS);
    views.push(view);

    expect(hasReplaceDecoration(view)).toBe(true);
    const span = getEmptyWidgetSpan(view);
    expect(span).not.toBeNull();
    expect(span?.style.display).toBe("none");
  });

  it("doc with block-sequence tags → empty span widget (widget ignores tag count)", () => {
    const view = makeView(DOC_WITH_BLOCK_TAGS);
    views.push(view);

    expect(hasReplaceDecoration(view)).toBe(true);
    const span = getEmptyWidgetSpan(view);
    expect(span).not.toBeNull();
    expect(span?.getAttribute("aria-hidden")).toBe("true");
  });
});


describe("frontmatterHidePlugin — FrontmatterEmptyWidget contract", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("empty span has aria-hidden='true'", () => {
    const view = makeView(DOC_WITH_TWO_TAGS);
    views.push(view);

    const span = getEmptyWidgetSpan(view);
    expect(span?.getAttribute("aria-hidden")).toBe("true");
  });

  it("empty span has display:none style", () => {
    const view = makeView(DOC_WITH_TWO_TAGS);
    views.push(view);

    const span = getEmptyWidgetSpan(view);
    expect(span?.style.display).toBe("none");
  });

  it("widget eq() returns true for two FrontmatterEmptyWidget instances", () => {
    const view = makeView(DOC_WITH_TWO_TAGS);
    views.push(view);

    const plugin = view.plugin(frontmatterHidePlugin);
    if (!plugin) throw new Error("Plugin not found");
    const cursor = plugin.decorations.iter();
    if (cursor.value?.spec?.widget) {
      const widget = cursor.value.spec.widget;
      expect(widget.eq(widget)).toBe(true);
    }
  });

  it("widget ignoreEvent() returns true — events are fully ignored", () => {
    const view = makeView(DOC_WITH_TWO_TAGS);
    views.push(view);

    const plugin = view.plugin(frontmatterHidePlugin);
    if (!plugin) throw new Error("Plugin not found");
    const cursor = plugin.decorations.iter();
    if (cursor.value?.spec?.widget) {
      expect(cursor.value.spec.widget.ignoreEvent()).toBe(true);
    }
  });

  it("widget renders <span> not <button>", () => {
    const view = makeView(DOC_WITH_TWO_TAGS);
    views.push(view);

    const plugin = view.plugin(frontmatterHidePlugin);
    if (!plugin) throw new Error("Plugin not found");
    const cursor = plugin.decorations.iter();
    if (cursor.value?.spec?.widget !== undefined) {
      const el = cursor.value.spec.widget.toDOM();
      expect(el.tagName.toLowerCase()).toBe("span");
    }
  });
});


describe("frontmatterHidePlugin — toggle StateEffect", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("dispatching toggleFrontmatterVisibility → switches to line decorations (raw view)", () => {
    const view = makeView(DOC_WITH_TWO_TAGS);
    views.push(view);

    expect(hasReplaceDecoration(view)).toBe(true);

    view.dispatch({ effects: toggleFrontmatterVisibility.of(undefined) });

    expect(hasReplaceDecoration(view)).toBe(false);
    expect(hasLineDecoration(view)).toBe(true);
  });

  it("dispatching toggle twice → back to hidden (replace decoration)", () => {
    const view = makeView(DOC_WITH_TWO_TAGS);
    views.push(view);

    view.dispatch({ effects: toggleFrontmatterVisibility.of(undefined) });
    expect(hasReplaceDecoration(view)).toBe(false);

    view.dispatch({ effects: toggleFrontmatterVisibility.of(undefined) });
    expect(hasReplaceDecoration(view)).toBe(true);
  });
});


describe("frontmatterHidePlugin — keymap", () => {
  it("frontmatterToggleKeymap is defined and importable", () => {
    expect(frontmatterToggleKeymap).toBeDefined();
  });

  it("frontmatterToggleKeymap registers 'Mod-Shift-y' binding without error", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: DOC_WITH_TWO_TAGS,
        extensions: [
          yamlFrontmatter({ content: markdown() }),
          frontmatterHideExtension,
          frontmatterToggleKeymap,
        ],
      }),
    });

    expect(view.state.doc.length).toBeGreaterThan(0);
    view.destroy();
  });

  it("frontmatterToggleKeymap key is 'Mod-Shift-y'", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: DOC_WITH_TWO_TAGS,
        extensions: [
          yamlFrontmatter({ content: markdown() }),
          frontmatterHideExtension,
          frontmatterToggleKeymap,
        ],
      }),
    });

    expect(view.state.doc.toString()).toContain("tags: [foo, bar]");
    view.destroy();
  });
});


describe("frontmatterHidePlugin — note-switch reset", () => {
  it("creating a new EditorView resets frontmatterHidden to true", () => {
    const parent1 = document.createElement("div");
    document.body.append(parent1);
    const view1 = new EditorView({
      parent: parent1,
      state: EditorState.create({
        doc: DOC_WITH_TWO_TAGS,
        extensions: [yamlFrontmatter({ content: markdown() }), frontmatterHideExtension],
      }),
    });

    view1.dispatch({ effects: toggleFrontmatterVisibility.of(undefined) });
    expect(hasReplaceDecoration(view1)).toBe(false);

    view1.destroy();

    const parent2 = document.createElement("div");
    document.body.append(parent2);
    const view2 = new EditorView({
      parent: parent2,
      state: EditorState.create({
        doc: DOC_WITH_TWO_TAGS,
        extensions: [yamlFrontmatter({ content: markdown() }), frontmatterHideExtension],
      }),
    });

    expect(hasReplaceDecoration(view2)).toBe(true);

    view2.destroy();
  });
});


describe("frontmatterHidePlugin — IME composition gate", () => {
  it("decorations survive mapping through no-op changes (composition guard)", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: DOC_WITH_TWO_TAGS,
        extensions: [yamlFrontmatter({ content: markdown() }), frontmatterHideExtension],
      }),
    });

    const plugin = view.plugin(frontmatterHidePlugin);
    expect(plugin).not.toBeNull();

    const emptyTx = view.state.update({});
    const mapped = plugin!.decorations.map(emptyTx.changes);
    let count = 0;
    const cursor = mapped.iter();
    while (cursor.value !== null) {
      count++;
      cursor.next();
    }

    expect(count).toBeGreaterThan(0);

    view.destroy();
  });
});


/** Find the frontmatter node's `.to` boundary (first editable position) via syntaxTree. */
function findFrontmatterBoundary(view: EditorView): number | null {
  let boundary: number | null = null;
  syntaxTree(view.state).iterate({
    enter(node) {
      if (node.name === FRONTMATTER_NODE_NAME) boundary = node.to;
    },
  });
  return boundary;
}

/**
 * Mount a view with the guard keymap (and defaultKeymap as the fallback layer)
 * so pressBackspace exercises the exact CM6 conflict-resolution path used in
 * MarkdownEditor.tsx (guard keymap registered before defaultKeymap).
 */
function makeViewWithGuard(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        yamlFrontmatter({ content: markdown() }),
        frontmatterHideExtension,
        frontmatterBackspaceGuardKeymap,
        keymap.of(defaultKeymap),
      ],
    }),
  });
}

/**
 * Dispatch a real "Backspace" keydown event at view.contentDOM — the same
 * mechanism CM6's own DOM observer uses internally (see @codemirror/view's
 * private `dispatchKey` helper, which drives Enter/Backspace/Delete this way).
 * Returns true if a handler called preventDefault() (i.e. the key was "swallowed").
 */
function pressBackspace(view: EditorView): boolean {
  const event = new KeyboardEvent("keydown", {
    key: "Backspace",
    code: "Backspace",
    keyCode: 8,
    which: 8,
    cancelable: true,
    bubbles: true,
  });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("frontmatterBackspaceGuardKeymap — D-23 boundary guard", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("hidden=true, cursor at the frontmatter boundary, Backspace → swallowed (true), doc unchanged", () => {
    const view = makeViewWithGuard(DOC_WITH_TWO_TAGS);
    views.push(view);

    const boundary = findFrontmatterBoundary(view);
    expect(boundary).not.toBeNull();
    view.dispatch({ selection: { anchor: boundary! } });

    const docBefore = view.state.doc.toString();
    const handled = pressBackspace(view);

    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe(docBefore);
  });

  it("hidden=true, cursor NOT at the boundary (mid-body), Backspace → not swallowed, normal deletion occurs", () => {
    const view = makeViewWithGuard(DOC_WITH_TWO_TAGS);
    views.push(view);

    const bodyPos = view.state.doc.toString().indexOf("Body") + 2;
    view.dispatch({ selection: { anchor: bodyPos } });

    const docBefore = view.state.doc.toString();
    const handled = pressBackspace(view);

    expect(handled).toBe(true); // defaultKeymap's deleteCharBackward handles+prevents it
    expect(view.state.doc.toString()).not.toBe(docBefore);
    expect(view.state.doc.toString().length).toBe(docBefore.length - 1);
  });

  it("hidden=false (raw view), Backspace at the same boundary position → not swallowed, normal deletion occurs", () => {
    const view = makeViewWithGuard(DOC_WITH_TWO_TAGS);
    views.push(view);

    const boundary = findFrontmatterBoundary(view);
    expect(boundary).not.toBeNull();

    view.dispatch({ effects: toggleFrontmatterVisibility.of(undefined) });
    view.dispatch({ selection: { anchor: boundary! } });

    const docBefore = view.state.doc.toString();
    const handled = pressBackspace(view);

    expect(handled).toBe(true); // handled by defaultKeymap, not the guard — guard returned false
    expect(view.state.doc.toString().length).toBe(docBefore.length - 1);
  });

  it("hidden=true, ArrowLeft/Home at the boundary do not corrupt frontmatter (no guard needed for movement keys)", () => {
    const view = makeViewWithGuard(DOC_WITH_TWO_TAGS);
    views.push(view);

    const boundary = findFrontmatterBoundary(view);
    expect(boundary).not.toBeNull();
    const docBefore = view.state.doc.toString();

    view.dispatch({ selection: { anchor: boundary! } });
    view.dispatch({ selection: { anchor: 0 } }); // simulates Home: cursor move only, no doc change
    view.dispatch({ selection: { anchor: boundary! } });
    view.dispatch({ selection: { anchor: Math.max(0, boundary! - 1) } }); // simulates ArrowLeft

    expect(view.state.doc.toString()).toBe(docBefore);
    expect(hasReplaceDecoration(view)).toBe(true);
  });
});


describe("countTagsInFrontmatter — helper preserved", () => {
  it("flow-sequence: tags: [foo, bar] → 2", () => {
    expect(countTagsInFrontmatter("tags: [foo, bar]")).toBe(2);
  });

  it("flow-sequence: tags: [] → 0", () => {
    expect(countTagsInFrontmatter("tags: []")).toBe(0);
  });

  it("block-sequence: tags:\\n  - alpha\\n  - beta → 2", () => {
    expect(countTagsInFrontmatter("tags:\n  - alpha\n  - beta\n")).toBe(2);
  });

  it("no tags key → 0", () => {
    expect(countTagsInFrontmatter("foo: bar\nbaz: qux")).toBe(0);
  });
});
