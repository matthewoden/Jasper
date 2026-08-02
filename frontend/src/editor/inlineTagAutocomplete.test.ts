/**
 * inlineTagAutocomplete.test.ts — TDD suite for the inline `#` autocomplete source.
 *
 * Requirements:
 *   - Trigger: `#` in body text (NOT inside code or frontmatter)
 *   - Source: module-level snapshot set via setInlineTagSnapshot
 *   - Filter: CM6 autocomplete handles filtering; `from` = match.from + 1 (after #)
 *   - No "Create new" row
 *   - Cursor inside code/frontmatter → returns null
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { CompletionContext } from "@codemirror/autocomplete";
import type { TagWithCount } from "../lib/tagsApi";


import {
  inlineTagCompletionSource,
  setInlineTagSnapshot,
} from "./inlineTagAutocomplete";


function makeCtx(doc: string, pos: number): CompletionContext {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: pos },
      extensions: [yamlFrontmatter({ content: markdown() })],
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


describe("inlineTagCompletionSource", () => {
  beforeEach(() => {
    setInlineTagSnapshot(SAMPLE_TAGS);
  });

  afterEach(() => {
    setInlineTagSnapshot([]);
  });

  it("IAC1: cursor right after # at line start in body → returns CompletionResult with all tags", async () => {
    const doc = "#";
    const ctx = makeCtx(doc, 1);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).not.toBeNull();
    expect(result!.options.length).toBeGreaterThan(0);
    const labels = result!.options.map((o) => o.label);
    expect(labels).toContain("foo");
    expect(labels).toContain("bar");
  });

  it("IAC2: cursor at #fo → returns CompletionResult with `from` after #", async () => {
    const doc = "#fo";
    const ctx = makeCtx(doc, 3);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).not.toBeNull();
    expect(result!.from).toBe(1);
  });

  it("IAC3: cursor at '# ' (hash + space) → returns null (not a tag trigger)", async () => {
    const doc = "# ";
    const ctx = makeCtx(doc, 2);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).toBeNull();
  });

  it("IAC4: cursor at text #foo| (cursor mid-tag) → returns CompletionResult", async () => {
    const doc = "text #foo more";
    const pos = doc.indexOf("#foo") + 2;
    const ctx = makeCtx(doc, pos);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).not.toBeNull();
  });

  it("IAC5: cursor inside fenced code block at #fo → returns null (code guard)", async () => {
    const doc = "```\n#fo\n```\nbody";
    const pos = doc.indexOf("#fo") + 3;
    const ctx = makeCtx(doc, pos);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).toBeNull();
  });

  it("IAC6: cursor inside frontmatter at #fo → returns null (frontmatter guard)", async () => {
    const doc = "---\ntitle: #fo\n---\nbody";
    const pos = doc.indexOf("#fo") + 3;
    const ctx = makeCtx(doc, pos);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).toBeNull();
  });

  it("IAC7: no 'Create new tag' entry in results", async () => {
    const doc = "#xyz";
    const ctx = makeCtx(doc, 4);

    const result = await inlineTagCompletionSource(ctx);

    if (result) {
      const labels = result.options.map((o) => o.label.toLowerCase());
      const details = result.options.map((o) => (o.detail ?? "").toLowerCase());
      for (const label of labels) {
        expect(label).not.toMatch(/create/i);
      }
      for (const detail of details) {
        expect(detail).not.toMatch(/create/i);
      }
    }
    // If null, that's also fine — means no matching tags and no Create row
  });

  it("IAC8: setInlineTagSnapshot([]) → returns null (no tags to show)", async () => {
    setInlineTagSnapshot([]);
    const doc = "#foo";
    const ctx = makeCtx(doc, 4);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).toBeNull();
  });

  it("IAC9: setInlineTagSnapshot([{name:baz}]) → baz appears in results", async () => {
    setInlineTagSnapshot([makeTag("baz", 5)]);
    const doc = "#baz";
    const ctx = makeCtx(doc, 4);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).not.toBeNull();
    const labels = result!.options.map((o) => o.label);
    expect(labels).toContain("baz");
  });

  it("IAC10: from is result.from = match.from + 1 so acceptance inserts after #", async () => {
    const doc = "#fo";
    const ctx = makeCtx(doc, 3);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).not.toBeNull();
    expect(result!.from).toBe(1);
    const labels = result!.options.map((o) => o.label);
    for (const label of labels) {
      expect(label).not.toMatch(/^#/);
    }
  });
});
