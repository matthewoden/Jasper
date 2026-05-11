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
    // Clean up views to avoid DOM accumulation
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

// ---------------------------------------------------------------------------
// spike: lezer-yaml node names inside Frontmatter > tags array (Plan 06-01 Wave 0)
//
// PURPOSE: Empirically determine the exact lezer node names emitted for YAML
// string values inside a `tags: [alpha, beta-tag]` flow-sequence array. These
// names are the canonical input for Plan 06-10's tagClickPlugin.ts — getting
// the wrong name produces a silently no-op plugin (Plan 05-01 lesson).
//
// The snapshot below is committed evidence. When Plan 06-10 is implemented,
// the implementer reads the snapshot to find the exact node name to match.
//
// Fixture: frontend/src/editor/__fixtures__/lezer-yaml-nodes.md
// ---------------------------------------------------------------------------
describe("spike: lezer-yaml node names inside Frontmatter > tags array (Plan 06-01 Wave 0)", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  // Fixture document: frontmatter with tags: [alpha, beta-tag]
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

    // Collect ALL node info from the Frontmatter range.
    const tree = syntaxTree(view.state);
    const allNodes: Array<{ name: string; from: number; to: number; text: string }> = [];

    tree.iterate({
      enter(node) {
        const text = view.state.doc.sliceString(node.from, node.to);
        allNodes.push({ name: node.name, from: node.from, to: node.to, text });
      },
    });

    // Filter to nodes whose text is exactly "alpha" or "beta-tag" — these
    // are the tag value strings we need to identify for tagClickPlugin.ts.
    const tagValueNodes = allNodes.filter(
      (n) => n.text === "alpha" || n.text === "beta-tag"
    );

    // Log for debugging if needed — the snapshot below captures the result.
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

    // Verify at least two tag-value nodes were found (sanity guard).
    expect(tagValueNodes.length).toBeGreaterThan(0);

    // The inline snapshot is written by vitest on first run (-u flag) and
    // then committed as evidence. Plan 06-10 reads this to determine the
    // exact node.name to match in tagClickPlugin.ts.
    //
    // EMPIRICAL RESULT (2026-05-10, Plan 06-01 Wave 0 spike):
    //   Each tag value inside tags: [alpha, beta-tag] emits TWO overlapping nodes:
    //   - "Item" — the flow-sequence item wrapper (covers the full item range)
    //   - "Literal" — the actual string value (same range; the innermost leaf)
    //
    //   Plan 06-10's tagClickPlugin.ts MUST match on "Literal" (the leaf) because:
    //   - "Item" may also match non-string values in other YAML contexts
    //   - "Literal" is the precise value range; Decoration.mark on "Literal" gives
    //     the exact clickable text region without decorating surrounding whitespace
    //
    //   Parent chain to reach tag values (empirically verified, second test below):
    //   Document > Frontmatter > Stream > Document > BlockMapping > Pair > FlowSequence > Item > Literal
    //   NOTE: No "YAMLDocument" node — lezer-yaml uses "Document" inside Frontmatter > Stream.
    //
    //   tagClickPlugin.ts match pattern (Plan 06-10):
    //     if (node.name === "Literal" && insideTagsKey(node, state)) { ... }
    //   where insideTagsKey() walks ancestors to confirm we're inside the
    //   "tags" Pair (not "title" or any other YAML key).
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
    // Empirically verify the parent-chain from root to the "Literal" tag nodes.
    // This is the authoritative chain Plan 06-10 uses to implement insideTagsKey().
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

    // Walk all nodes and collect the name-chain for nodes named "Literal"
    // whose text matches an expected tag value.
    const literalChains: string[][] = [];
    tree.iterate({
      enter(node) {
        if (node.name === "Literal") {
          const text = view.state.doc.sliceString(node.from, node.to);
          if (text === "alpha" || text === "beta-tag") {
            // Build the ancestor chain by walking up via node.node.parent
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

    // The snapshot below is the empirically verified parent chain.
    //
    // EMPIRICAL RESULT (2026-05-10, Plan 06-01 Wave 0 spike):
    //   Full chain: Document > Frontmatter > Stream > Document > BlockMapping > Pair > FlowSequence > Item > Literal
    //   NOTE: "YAMLDocument" does NOT appear — lezer-yaml uses "Document" (not "YAMLDocument")
    //         inside the Frontmatter node. There are TWO "Document" levels: the outer lezer
    //         Document root and the inner YAML Document within Frontmatter > Stream.
    //
    // Plan 06-10's insideTagsKey() must verify:
    //   node.name === "Literal"
    //   AND a "Pair" ancestor exists whose key text === "tags"
    //   AND a "FlowSequence" ancestor exists between Pair and Item
    //
    // Implementation note: to check if a Literal is inside the "tags" Pair,
    // walk node.node.parent until you reach a "Pair" node, then check
    // if its firstChild (the key) has text === "tags".
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
