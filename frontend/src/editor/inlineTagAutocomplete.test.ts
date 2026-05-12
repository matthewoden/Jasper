/**
 * inlineTagAutocomplete.test.ts — TDD suite for the inline `#` autocomplete source.
 *
 * Phase 6.5 / Plan 06.5-05 / Task 2.
 *
 * Requirements (UX-T-02 / D-14):
 *   - Trigger: `#` in body text (NOT inside code or frontmatter)
 *   - Source: module-level snapshot set via setInlineTagSnapshot
 *   - Filter: CM6 autocomplete handles filtering; `from` = match.from + 1 (after #)
 *   - No "Create new" row (D-14)
 *   - Cursor inside code/frontmatter → returns null
 *
 * TDD sequence:
 *   RED  → this file (failures: inlineTagAutocomplete.ts not yet written)
 *   GREEN → implement inlineTagAutocomplete.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { CompletionContext } from "@codemirror/autocomplete";
import type { TagWithCount } from "../lib/tagsApi";

// Module under test
import {
  inlineTagCompletionSource,
  setInlineTagSnapshot,
} from "./inlineTagAutocomplete";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inlineTagCompletionSource", () => {
  beforeEach(() => {
    setInlineTagSnapshot(SAMPLE_TAGS);
  });

  afterEach(() => {
    setInlineTagSnapshot([]);
  });

  // IAC1: cursor right after # in body → returns CompletionResult
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

  // IAC2: cursor at #fo → returns CompletionResult (CM6 will filter to foo/foobar)
  it("IAC2: cursor at #fo → returns CompletionResult with `from` after #", async () => {
    const doc = "#fo";
    const ctx = makeCtx(doc, 3);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).not.toBeNull();
    // The `from` should be 1 (after the # so CM6 replaces only the tagname part)
    expect(result!.from).toBe(1);
  });

  // IAC3: cursor at # followed by space → returns null (not a tag trigger)
  it("IAC3: cursor at '# ' (hash + space) → returns null (not a tag trigger)", async () => {
    const doc = "# ";
    const ctx = makeCtx(doc, 2); // after the space

    const result = await inlineTagCompletionSource(ctx);

    expect(result).toBeNull();
  });

  // IAC4: cursor inside #foo mid-word → returns CompletionResult
  it("IAC4: cursor at text #foo| (cursor mid-tag) → returns CompletionResult", async () => {
    const doc = "text #foo more";
    const pos = doc.indexOf("#foo") + 2; // cursor at #fo
    const ctx = makeCtx(doc, pos);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).not.toBeNull();
  });

  // IAC5: cursor inside fenced code at #fo → returns null
  it("IAC5: cursor inside fenced code block at #fo → returns null (code guard)", async () => {
    const doc = "```\n#fo\n```\nbody";
    const pos = doc.indexOf("#fo") + 3;
    const ctx = makeCtx(doc, pos);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).toBeNull();
  });

  // IAC6: cursor inside frontmatter at #fo → returns null
  it("IAC6: cursor inside frontmatter at #fo → returns null (frontmatter guard)", async () => {
    const doc = "---\ntitle: #fo\n---\nbody";
    const pos = doc.indexOf("#fo") + 3;
    const ctx = makeCtx(doc, pos);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).toBeNull();
  });

  // IAC7: no "Create new" row in results
  it("IAC7: no 'Create new tag' entry in results (D-14)", async () => {
    const doc = "#xyz";
    const ctx = makeCtx(doc, 4);

    const result = await inlineTagCompletionSource(ctx);

    if (result) {
      const labels = result.options.map((o) => o.label.toLowerCase());
      const details = result.options.map((o) => (o.detail ?? "").toLowerCase());
      // No "Create" keyword in label or detail
      for (const label of labels) {
        expect(label).not.toMatch(/create/i);
      }
      for (const detail of details) {
        expect(detail).not.toMatch(/create/i);
      }
    }
    // If null, that's also fine — means no matching tags and no Create row
  });

  // IAC8: snapshot update — empty snapshot → no results
  it("IAC8: setInlineTagSnapshot([]) → returns null (no tags to show)", async () => {
    setInlineTagSnapshot([]);
    const doc = "#foo";
    const ctx = makeCtx(doc, 4);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).toBeNull();
  });

  // IAC9: snapshot update — single tag → single result
  it("IAC9: setInlineTagSnapshot([{name:baz}]) → baz appears in results", async () => {
    setInlineTagSnapshot([makeTag("baz", 5)]);
    const doc = "#baz";
    const ctx = makeCtx(doc, 4);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).not.toBeNull();
    const labels = result!.options.map((o) => o.label);
    expect(labels).toContain("baz");
  });

  // IAC10: accepting a completion with #fo|cursor produces #foo (from is after #)
  it("IAC10: from is result.from = match.from + 1 so acceptance inserts after #", async () => {
    const doc = "#fo";
    const ctx = makeCtx(doc, 3);

    const result = await inlineTagCompletionSource(ctx);

    expect(result).not.toBeNull();
    // from should be 1 (the position after #, before "fo")
    expect(result!.from).toBe(1);
    // The options should have the tagname WITHOUT the #
    const labels = result!.options.map((o) => o.label);
    for (const label of labels) {
      expect(label).not.toMatch(/^#/);
    }
  });
});
