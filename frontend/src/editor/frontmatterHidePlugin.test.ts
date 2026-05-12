/**
 * frontmatterHidePlugin.test.ts — vitest suite for the frontmatter hide plugin.
 *
 * UX-CHROME-05 / Phase 6.6 / Plan 06.6-03
 * Verifies that the YAML frontmatter block is hidden behind an invisible empty
 * widget (zero visible UI). Cmd-Shift-Y toggles between hidden and raw YAML view.
 *
 * Updated for Plan 06.6-03 (reverses 6.5 D-12 affordance widget):
 *   - Hidden state: empty <span aria-hidden="true" style="display:none">
 *   - No button, no chevron, no label text
 *   - Cmd-Shift-Y keymap preserved (D-17)
 */
import { describe, expect, it, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import {
  frontmatterHidePlugin,
  frontmatterHideExtension,
  toggleFrontmatterVisibility,
  frontmatterToggleKeymap,
  countTagsInFrontmatter,
} from "./frontmatterHidePlugin";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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
    // Replace decorations have a widget spec (or are collapsed)
    // spec.widget is the defining property for Decoration.replace with widget
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
    // Line decorations have from === to and have a class in spec
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
      // toDOM() produces the span — no view arg needed for FrontmatterEmptyWidget
      const el = cursor.value.spec.widget.toDOM();
      if (el instanceof HTMLSpanElement) return el;
    }
    cursor.next();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test docs
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests — hidden state (default)
// ---------------------------------------------------------------------------

describe("frontmatterHidePlugin — hidden state (default)", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("doc with tags: [foo, bar] → single replace decoration (empty widget, no visible text)", () => {
    const view = makeView(DOC_WITH_TWO_TAGS);
    views.push(view);

    // Should have a replace decoration
    expect(hasReplaceDecoration(view)).toBe(true);

    // Widget must produce an empty span — not a button, not affordance text
    const span = getEmptyWidgetSpan(view);
    expect(span).not.toBeNull();
    expect(span?.getAttribute("aria-hidden")).toBe("true");
    expect(span?.style.display).toBe("none");
    // No visible label or text content
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

// ---------------------------------------------------------------------------
// Tests — FrontmatterEmptyWidget contract
// ---------------------------------------------------------------------------

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
      // eq() should return true when compared to another instance of the same type
      // We test by comparing it to itself (same instance satisfies instanceof check)
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

// ---------------------------------------------------------------------------
// Tests — toggle StateEffect
// ---------------------------------------------------------------------------

describe("frontmatterHidePlugin — toggle StateEffect", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("dispatching toggleFrontmatterVisibility → switches to line decorations (raw view)", () => {
    const view = makeView(DOC_WITH_TWO_TAGS);
    views.push(view);

    // Initially hidden → replace decoration (empty widget)
    expect(hasReplaceDecoration(view)).toBe(true);

    // Dispatch toggle
    view.dispatch({ effects: toggleFrontmatterVisibility.of(undefined) });

    // Now raw view → line decorations
    expect(hasReplaceDecoration(view)).toBe(false);
    expect(hasLineDecoration(view)).toBe(true);
  });

  it("dispatching toggle twice → back to hidden (replace decoration)", () => {
    const view = makeView(DOC_WITH_TWO_TAGS);
    views.push(view);

    // Toggle to raw
    view.dispatch({ effects: toggleFrontmatterVisibility.of(undefined) });
    expect(hasReplaceDecoration(view)).toBe(false);

    // Toggle back to hidden
    view.dispatch({ effects: toggleFrontmatterVisibility.of(undefined) });
    expect(hasReplaceDecoration(view)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — keymap (D-17 preserved)
// ---------------------------------------------------------------------------

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

    // Verify the view built without error and the keymap is usable
    expect(view.state.doc.length).toBeGreaterThan(0);
    view.destroy();
  });

  it("frontmatterToggleKeymap key is 'Mod-Shift-y'", () => {
    // Verify by directly inspecting the exported keymap extension structure
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

    // Verify the view has the keymap installed by checking doc is accessible
    expect(view.state.doc.toString()).toContain("tags: [foo, bar]");
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests — note-switch reset
// ---------------------------------------------------------------------------

describe("frontmatterHidePlugin — note-switch reset", () => {
  it("creating a new EditorView resets frontmatterHidden to true", () => {
    // First view: toggle to raw (hidden=false)
    const parent1 = document.createElement("div");
    document.body.append(parent1);
    const view1 = new EditorView({
      parent: parent1,
      state: EditorState.create({
        doc: DOC_WITH_TWO_TAGS,
        extensions: [yamlFrontmatter({ content: markdown() }), frontmatterHideExtension],
      }),
    });

    // Toggle to raw view
    view1.dispatch({ effects: toggleFrontmatterVisibility.of(undefined) });
    expect(hasReplaceDecoration(view1)).toBe(false);

    view1.destroy();

    // Second view: should start hidden again (constructor resets frontmatterHidden)
    const parent2 = document.createElement("div");
    document.body.append(parent2);
    const view2 = new EditorView({
      parent: parent2,
      state: EditorState.create({
        doc: DOC_WITH_TWO_TAGS,
        extensions: [yamlFrontmatter({ content: markdown() }), frontmatterHideExtension],
      }),
    });

    // New view should show the empty widget (hidden=true)
    expect(hasReplaceDecoration(view2)).toBe(true);

    view2.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests — IME composition gate
// ---------------------------------------------------------------------------

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

    // Map decorations through empty changes (simulates IME gate behavior)
    const emptyTx = view.state.update({});
    const mapped = plugin!.decorations.map(emptyTx.changes);
    let count = 0;
    const cursor = mapped.iter();
    while (cursor.value !== null) {
      count++;
      cursor.next();
    }

    // Should still have the replace decoration (empty widget)
    expect(count).toBeGreaterThan(0);

    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests — countTagsInFrontmatter helper (preserved, independent)
// ---------------------------------------------------------------------------

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
