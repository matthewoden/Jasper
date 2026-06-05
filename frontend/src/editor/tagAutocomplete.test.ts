/**
 * tagAutocomplete.test.ts — TDD suite for the tag-name CompletionSource.
 *
 * Phase 6 / Plan 06-10 / Task 3.
 *
 * Requirements:
 *   D-07: Tag autocomplete inside tags: [...] array
 *   D-44: NO Create row (tags become valid on save; no pre-existence needed)
 *
 * Detection strategy (SPIKE-FINDINGS.md Plan 06-01):
 *   The cursor is "inside the tags array" when the line text before the cursor
 *   matches `^tags:\s*\[` OR the cursor is inside a FlowSequence whose parent
 *   Pair key is "tags" inside Frontmatter.
 *   For robustness, we use a two-pronged approach:
 *     1. AST walk: if the Frontmatter node is present, check the lezer-yaml tree.
 *     2. Regex fallback: match the line context if AST context is unclear.
 *
 * TDD sequence:
 *   RED  → this file (failures: tagAutocomplete.ts not yet written)
 *   GREEN → implement tagAutocomplete.ts
 */
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { CompletionContext } from "@codemirror/autocomplete";
import type { TagWithCount } from "../lib/tagsApi";


import {
  tagCompletionSource,
  setTagSnapshot,
} from "./tagAutocomplete";


function makeCtx(doc: string, pos: number, extensions?: Extension | Extension[]): CompletionContext {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: pos },
      extensions: [
        yamlFrontmatter({ content: markdown() }),
        ...(Array.isArray(extensions) ? extensions : extensions ? [extensions] : []),
      ],
    }),
  });
  return new CompletionContext(view.state, pos, false);
}

function makeTag(name: string, count = 3): TagWithCount {
  return { name, count };
}

const SAMPLE_TAGS: TagWithCount[] = [
  makeTag("foo", 5),
  makeTag("foobar", 2),
  makeTag("bar", 8),
  makeTag("baz", 1),
];

describe("tagCompletionSource", () => {
  beforeEach(() => {
    setTagSnapshot(SAMPLE_TAGS);
  });

  afterEach(() => {
    setTagSnapshot([]);
  });

  it("TA1: cursor inside tags: [fo — returns foo and foobar", async () => {
    const doc = "---\ntags: [fo\n---\n# Body";
    const pos = doc.indexOf("fo") + 2;
    const ctx = makeCtx(doc, pos);

    const result = await tagCompletionSource(ctx);

    expect(result).not.toBeNull();
    const labels = result!.options.map((o) => o.label);
    expect(labels).toContain("foo");
    expect(labels).toContain("foobar");
    expect(labels).not.toContain("bar");
    expect(labels).not.toContain("baz");
  });

  it("TA2: cursor outside frontmatter returns null", async () => {
    const doc = "---\ntags: [foo]\n---\n# Body\nsome content here";
    const pos = doc.length;
    const ctx = makeCtx(doc, pos);

    const result = await tagCompletionSource(ctx);
    expect(result).toBeNull();
  });

  it("TA3: cursor inside frontmatter on title key returns null", async () => {
    const doc = "---\ntitle: f\n---\n# Body";
    const pos = doc.indexOf("f") + 1;
    const ctx = makeCtx(doc, pos);

    const result = await tagCompletionSource(ctx);
    expect(result).toBeNull();
  });

  it("TA4: cursor after comma+space in tags array → lists all tags", async () => {
    const doc = "---\ntags: [foo, \n---\n# Body";
    const pos = doc.indexOf("foo, ") + 5;
    const ctx = makeCtx(doc, pos);

    const result = await tagCompletionSource(ctx);

    expect(result).not.toBeNull();
    const labels = result!.options.map((o) => o.label);
    expect(labels.length).toBe(4);
    expect(labels).toContain("foo");
    expect(labels).toContain("bar");
  });

  it("TA5: NO Create row in tag autocomplete (D-44)", async () => {
    const doc = "---\ntags: [newTag\n---\n# Body";
    const pos = doc.indexOf("newTag") + 6;
    const ctx = makeCtx(doc, pos);

    const result = await tagCompletionSource(ctx);

    if (result !== null) {
      const labels = result.options.map((o) => o.label);
      expect(labels.some((l) => /create/i.test(l))).toBe(false);
    }
    expect(true).toBe(true);
  });

  it("TA6: each option includes count in detail field", async () => {
    const doc = "---\ntags: [ba\n---\n# Body";
    const pos = doc.indexOf("ba") + 2;
    const ctx = makeCtx(doc, pos);

    const result = await tagCompletionSource(ctx);

    expect(result).not.toBeNull();
    for (const option of result!.options) {
      expect(option.detail).toMatch(/\d+/);
    }
  });

  it("TA7: selecting an option applies the tag name (not a custom function)", async () => {
    const doc = "---\ntags: [fo\n---\n# Body";
    const pos = doc.indexOf("fo") + 2;
    const ctx = makeCtx(doc, pos);

    const result = await tagCompletionSource(ctx);

    expect(result).not.toBeNull();
    const fooOption = result!.options.find((o) => o.label === "foo");
    expect(fooOption).toBeDefined();
    if (fooOption!.apply !== undefined) {
      expect(typeof fooOption!.apply).toBe("string");
      expect(fooOption!.apply).toBe("foo");
    }
  });

  it("TA8: empty tag snapshot returns null or empty options", async () => {
    setTagSnapshot([]);

    const doc = "---\ntags: [fo\n---\n# Body";
    const pos = doc.indexOf("fo") + 2;
    const ctx = makeCtx(doc, pos);

    const result = await tagCompletionSource(ctx);

    expect(result === null || result!.options.length === 0).toBe(true);
  });
});
