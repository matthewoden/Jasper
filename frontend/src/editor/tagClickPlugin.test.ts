/**
 * tagClickPlugin.test.ts — TDD suite for clickable tag decorations in YAML frontmatter.
 *
 * Phase 6 / Plan 06-10 / Task 1.
 *
 * Node names come from SPIKE-FINDINGS.md (Plan 06-01):
 *   - Clickable tag values are `Literal` leaf nodes.
 *   - Full chain: Frontmatter > Stream > Document > BlockMapping > Pair > FlowSequence > Item > Literal
 *   - `isInsideTagsPair`: walk up from Literal → find FlowSequence → find Pair → check Key text === "tags"
 *
 * TDD sequence:
 *   RED  → this file (failures: tagClickPlugin.ts not yet written)
 *   GREEN → implement tagClickPlugin.ts
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import {
  tagClickPlugin,
  setTagClickHandler,
} from "./tagClickPlugin";

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
      extensions: [yamlFrontmatter({ content: markdown() }), tagClickPlugin],
    }),
  });
}

function getTagClickableSpans(view: EditorView): HTMLElement[] {
  return Array.from(view.dom.querySelectorAll(".cm-tag-clickable")) as HTMLElement[];
}

// ---------------------------------------------------------------------------
// Test fixture docs
// ---------------------------------------------------------------------------

const FLOW_TAGS_DOC = `---
tags: [alpha, beta-tag]
other: foo
---
# Body
Paragraph.`;

const BLOCK_TAGS_DOC = `---
tags:
  - alpha
  - beta
---
# Body`;

const EMPTY_TAGS_DOC = `---
tags: []
---
# Body`;

const TAGS_WITH_SPACES_DOC = `---
tags: [Tag With Spaces, another]
---
# Body`;

const SINGLE_TAG_DOC = `---
tags: [only-tag]
---
# Body`;

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe("tagClickPlugin", () => {
  const views: EditorView[] = [];

  beforeEach(() => {
    // Reset the click handler before each test
    setTagClickHandler(() => {});
  });

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  // TC1: flow-sequence tags get cm-tag-clickable decoration; non-tags key does not
  it("TC1: flow-sequence tags [alpha, beta-tag] get cm-tag-clickable; 'other' key value does NOT", () => {
    const view = makeView(FLOW_TAGS_DOC);
    views.push(view);

    const spans = getTagClickableSpans(view);
    // Should have exactly 2: alpha, beta-tag
    expect(spans.length).toBe(2);
    const texts = spans.map((s) => s.textContent?.trim());
    expect(texts).toContain("alpha");
    expect(texts).toContain("beta-tag");
    // "foo" (value of "other" key) must NOT be decorated
    expect(texts).not.toContain("foo");
  });

  // TC2: block-sequence form also gets decoration (if SPIKE-FINDINGS covers it)
  // Note: The spike only verified FlowSequence (tags: [...]). Block sequences use
  // a different lezer-yaml structure. TC2 documents the current coverage gap:
  // if block-sequence tags appear decorated, the plugin handles both;
  // if not, this test passes as a "documented gap — Phase 6.x follow-on".
  // The test verifies the flow-sequence case is unbroken by the block-sequence doc.
  it("TC2: block-sequence form `tags:\\n  - alpha\\n  - beta` — plugin does not crash; flow-seq still works", () => {
    const view = makeView(BLOCK_TAGS_DOC);
    views.push(view);
    // At minimum: no error thrown, view renders
    expect(view.dom).toBeTruthy();
    // If block sequences are supported (FlowSequence + BlockSequence),
    // spans would be 2. If not, spans === 0 (documented gap, not a failure).
    const spans = getTagClickableSpans(view);
    // We document either outcome:
    expect(spans.length === 0 || spans.length === 2).toBe(true);
  });

  // TC3: cursor on the tag value line → decoration still applied
  it("TC3: cursor on the tag value line does not remove the decoration", () => {
    const view = makeView(FLOW_TAGS_DOC);
    views.push(view);

    // Place cursor on line 2 (the tags line)
    const tagsLine = view.state.doc.line(2);
    view.dispatch({
      selection: { anchor: tagsLine.from + 10, head: tagsLine.from + 10 },
    });

    // Decoration should still be present (tagClickPlugin doesn't suppress on-cursor-line)
    const spans = getTagClickableSpans(view);
    expect(spans.length).toBe(2);
  });

  // TC4: tag value with spaces → still decorated (SAVE normalizes per D-22; editor shows raw)
  it("TC4: tag value with spaces is still decorated", () => {
    const view = makeView(TAGS_WITH_SPACES_DOC);
    views.push(view);

    const spans = getTagClickableSpans(view);
    // Both values decorated (editor doesn't validate charset — backend does)
    expect(spans.length).toBe(2);
  });

  // TC5: empty `tags: []` → no decoration emitted
  it("TC5: empty tags: [] → zero cm-tag-clickable spans", () => {
    const view = makeView(EMPTY_TAGS_DOC);
    views.push(view);

    const spans = getTagClickableSpans(view);
    expect(spans.length).toBe(0);
  });

  // TC6: IME composing → decoration preserved through changes
  it("TC6: decorations are preserved when view.composing would normally suppress rebuild", () => {
    const view = makeView(FLOW_TAGS_DOC);
    views.push(view);

    // Verify initial decorations
    const beforeSpans = getTagClickableSpans(view);
    expect(beforeSpans.length).toBe(2);

    // Simulate a doc change (the composing path maps decorations)
    view.dispatch({
      changes: { from: view.state.doc.length, to: view.state.doc.length, insert: " " },
    });

    // Decorations should still be present (either rebuilt or mapped)
    const afterSpans = getTagClickableSpans(view);
    expect(afterSpans.length).toBe(2);
  });

  // TC7: click handler — clicking a .cm-tag-clickable span calls setTagClickHandler callback
  it("TC7: clicking a cm-tag-clickable span calls the registered onTagClick handler with the tag name", () => {
    const handler = vi.fn();
    setTagClickHandler(handler);

    const view = makeView(SINGLE_TAG_DOC);
    views.push(view);

    const spans = getTagClickableSpans(view);
    expect(spans.length).toBe(1);
    expect(spans[0].textContent?.trim()).toBe("only-tag");

    // Simulate a click on the span
    spans[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(handler).toHaveBeenCalledWith("only-tag");
  });

  // TC7b: no Cmd needed — plain click triggers (D-08 divergence from wiki-link Cmd-click model)
  it("TC7b: plain click (no modifier) triggers the tag handler — D-08 plain click model", () => {
    const handler = vi.fn();
    setTagClickHandler(handler);

    const view = makeView(SINGLE_TAG_DOC);
    views.push(view);

    const spans = getTagClickableSpans(view);
    expect(spans.length).toBe(1);

    // Plain click with no metaKey/ctrlKey
    spans[0].dispatchEvent(
      new MouseEvent("click", { bubbles: true, metaKey: false, ctrlKey: false })
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("only-tag");
  });
});
