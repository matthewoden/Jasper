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
import type { SyntaxNode } from "@lezer/common";
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
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it('yamlFrontmatter produces a "Frontmatter" node — Assumption A2 verified (actual name: lowercase m)', () => {
    const view = makeView(FRONTMATTER_DOC);
    views.push(view);

    const tree = syntaxTree(view.state);
    const nodeNames: string[] = [];
    tree.iterate({
      enter(node) {
        nodeNames.push(node.name);
      },
    });

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

    let lineDecoCount = 0;
    const cursor = decorationSet.iter();
    while (cursor.value !== null) {
      if (cursor.from === cursor.to) {
        lineDecoCount++;
      }
      cursor.next();
    }

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
    const view = makeView(FRONTMATTER_DOC);
    views.push(view);

    const set1 = buildFrontmatterDecorations(view);
    let count1 = 0;
    const c1 = set1.iter();
    while (c1.value !== null) {
      count1++;
      c1.next();
    }

    const emptyTx = view.state.update({});
    const mappedSet = set1.map(emptyTx.changes);
    let count2 = 0;
    const c2 = mappedSet.iter();
    while (c2.value !== null) {
      count2++;
      c2.next();
    }

    expect(count2).toBe(count1);
    expect(count1).toBe(4);
  });
});


describe("spike: lezer-yaml node names inside Frontmatter > tags array (Plan 06-01 Wave 0)", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  const TAGS_FIXTURE = `---
tags: [alpha, beta-tag]
title: Example
---

# Body
`;

  it("captures yaml flow-sequence node names", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: TAGS_FIXTURE,
        extensions: [yamlFrontmatter({ content: markdown() })],
      }),
    });
    views.push(view);

    const tree = syntaxTree(view.state);
    const allNodes: Array<{ name: string; from: number; to: number; text: string }> = [];

    tree.iterate({
      enter(node) {
        const text = view.state.doc.sliceString(node.from, node.to);
        allNodes.push({ name: node.name, from: node.from, to: node.to, text });
      },
    });

    const tagValueNodes = allNodes.filter(
      (n) => n.text === "alpha" || n.text === "beta-tag"
    );

    if (tagValueNodes.length === 0) {
      console.error(
        "Spike FAILED: no nodes found with text 'alpha' or 'beta-tag'.\n" +
        "All nodes inside frontmatter range:\n" +
        allNodes
          .filter((n) => n.from < 30)
          .map((n) => `  ${n.name}: "${n.text}"`)
          .join("\n")
      );
    }

    expect(tagValueNodes.length).toBeGreaterThan(0);

    expect(tagValueNodes.map((n) => ({ name: n.name, text: n.text }))).toMatchInlineSnapshot(`
      [
        {
          "name": "Item",
          "text": "alpha",
        },
        {
          "name": "Literal",
          "text": "alpha",
        },
        {
          "name": "Item",
          "text": "beta-tag",
        },
        {
          "name": "Literal",
          "text": "beta-tag",
        },
      ]
    `);
  });

  it("captures the full node ancestry chain for tag Literal values", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: TAGS_FIXTURE,
        extensions: [yamlFrontmatter({ content: markdown() })],
      }),
    });
    views.push(view);

    const tree = syntaxTree(view.state);

    const literalChains: string[][] = [];
    tree.iterate({
      enter(node) {
        if (node.name === "Literal") {
          const text = view.state.doc.sliceString(node.from, node.to);
          if (text === "alpha" || text === "beta-tag") {
            const chain: string[] = [];
            let cur: SyntaxNode | null = node.node;
            while (cur) {
              chain.unshift(cur.name);
              cur = cur.parent;
            }
            literalChains.push(chain);
          }
        }
      },
    });

    expect(literalChains).toMatchInlineSnapshot(`
      [
        [
          "Document",
          "Frontmatter",
          "Stream",
          "Document",
          "BlockMapping",
          "Pair",
          "FlowSequence",
          "Item",
          "Literal",
        ],
        [
          "Document",
          "Frontmatter",
          "Stream",
          "Document",
          "BlockMapping",
          "Pair",
          "FlowSequence",
          "Item",
          "Literal",
        ],
      ]
    `);
  });
});
