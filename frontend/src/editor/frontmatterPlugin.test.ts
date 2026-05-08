/**
 * frontmatterPlugin.test.ts — vitest spike suite for the FrontMatter line
 * decoration plugin. Covers Assumption A2 (verified node name from
 * yamlFrontmatter()) plus basic decoration behavior and IME composition gate.
 *
 * Phase 5 Plan 05-01 (spike). Per TDD gate sequence:
 *   RED  → this file (failing; frontmatterPlugin.ts not yet written)
 *   GREEN → implement frontmatterPlugin.ts
 *   REFACTOR → (if needed)
 */
import { describe, expect, it, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { syntaxTree } from "@codemirror/language";
import {
  frontmatterPlugin,
  FRONTMATTER_NODE_NAME,
  buildFrontmatterDecorations,
} from "./frontmatterPlugin";
import { FRONTMATTER_DOC, HEADING_DOC } from "./__fixtures__/spike-doc";

function makeView(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [yamlFrontmatter({ content: markdown() }), frontmatterPlugin],
    }),
  });
}

describe("frontmatterPlugin", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    // Clean up views to avoid DOM accumulation
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("yamlFrontmatter produces a FrontMatter node — Assumption A2 verified", () => {
    const view = makeView(FRONTMATTER_DOC);
    views.push(view);

    const tree = syntaxTree(view.state);
    const nodeNames: string[] = [];
    tree.iterate({
      enter(node) {
        nodeNames.push(node.name);
      },
    });

    // Log actual node names so we can see what lezer produces
    const hasFrontMatter = nodeNames.includes(FRONTMATTER_NODE_NAME);
    if (!hasFrontMatter) {
      console.error(
        "Assumption A2 FAILED. Expected node name:",
        FRONTMATTER_NODE_NAME,
        "— Actual node names found:",
        nodeNames.filter((n) => n.toLowerCase().includes("front") || n.toLowerCase().includes("yaml"))
      );
      console.error("All node names:", nodeNames);
    }

    expect(hasFrontMatter).toBe(true);
  });

  it("emits a line decoration for every line in the frontmatter range", () => {
    const view = makeView(FRONTMATTER_DOC);
    views.push(view);

    const decorationSet = buildFrontmatterDecorations(view);

    // Count Decoration.line entries — iterate the RangeSet
    let lineDecoCount = 0;
    const cursor = decorationSet.iter();
    while (cursor.value !== null) {
      // Decoration.line has from === to and spec.line === true
      // or we can check cursor.from === cursor.to (line decorations are zero-width)
      if (cursor.from === cursor.to) {
        lineDecoCount++;
      }
      cursor.next();
    }

    // FRONTMATTER_DOC has these frontmatter lines:
    //   line 1: ---
    //   line 2: title: Test note
    //   line 3: tags: [foo, bar]
    //   line 4: ---
    // Expect 4 line decorations
    expect(lineDecoCount).toBe(4);
  });

  it("emits zero decorations when the doc has no frontmatter", () => {
    const view = makeView(HEADING_DOC);
    views.push(view);

    const decorationSet = buildFrontmatterDecorations(view);

    let decoCount = 0;
    const cursor = decorationSet.iter();
    while (cursor.value !== null) {
      decoCount++;
      cursor.next();
    }

    expect(decoCount).toBe(0);
  });

  it("preserves decorations during IME composition by mapping through changes", () => {
    // Since view.composing is read-only, we test the BEHAVIOR of the
    // composing-gate directly: the gate calls this.decorations.map(u.changes)
    // instead of rebuilding. We verify that mapping an existing DecorationSet
    // through a no-op ChangeSet preserves the same decoration count.
    // This is the exact operation the composing-gate performs.
    const view = makeView(FRONTMATTER_DOC);
    views.push(view);

    // Build decorations once to establish baseline
    const set1 = buildFrontmatterDecorations(view);
    let count1 = 0;
    const c1 = set1.iter();
    while (c1.value !== null) {
      count1++;
      c1.next();
    }

    // Map the existing set through empty changes — this is what the
    // composing gate does (u.decorations.map(u.changes))
    const emptyTx = view.state.update({});
    const mappedSet = set1.map(emptyTx.changes);
    let count2 = 0;
    const c2 = mappedSet.iter();
    while (c2.value !== null) {
      count2++;
      c2.next();
    }

    // Same count: no decorations were lost by mapping through no-op changes
    expect(count2).toBe(count1);
    // Baseline: frontmatter doc should have 4 line decorations
    expect(count1).toBe(4);
  });
});
