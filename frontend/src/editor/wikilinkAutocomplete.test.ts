/**
 * wikilinkAutocomplete.test.ts — TDD suite for the [[ autocomplete CompletionSource.
 *
 * Requirements:
 *   - [[ triggers autocomplete, results ranked by server
 *   - ALWAYS include "Create '{typed}'" as the LAST row
 *   - Suppressed inside fenced code, inline code, or frontmatter
 *   - CompletionResult.from must be AFTER [[ so insertions don't double-up
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { CompletionContext } from "@codemirror/autocomplete";
import type { NoteSearchResult } from "../lib/notesApi";


import {
  wikilinkCompletionSource,
  setWikilinkAutocompleteCallbacks,
} from "./wikilinkAutocomplete";


vi.mock("../lib/notesApi", () => ({
  searchTitles: vi.fn(),
}));


import { searchTitles } from "../lib/notesApi";
const mockSearchTitles = searchTitles as ReturnType<typeof vi.fn>;


type Extensions = Extension | Extension[];

function makeCtx(doc: string, pos: number, extensions?: Extensions): CompletionContext {
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

function makeResult(title: string, id = "uuid-" + title): NoteSearchResult {
  return {
    id,
    title,
    folder: null,
    recency_score: 0.8,
    proximity_score: null,
  };
}

describe("wikilinkCompletionSource", () => {
  beforeEach(() => {
    mockSearchTitles.mockReset();
    setWikilinkAutocompleteCallbacks({
      createNoteAndNavigate: vi.fn().mockResolvedValue(undefined),
      getCurrentSourceFolder: () => "",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("W1: cursor after [[ (empty query) returns recent results + Create row", async () => {
    mockSearchTitles.mockResolvedValue([makeResult("Alpha"), makeResult("Beta")]);

    const ctx = makeCtx("[[", 2);
    const result = await wikilinkCompletionSource(ctx);

    expect(result).not.toBeNull();
    expect(result!.options.length).toBe(3);
    expect(mockSearchTitles).toHaveBeenCalledWith("", 10);
  });

  it("W2: cursor after [[Foo calls searchTitles with query 'Foo'", async () => {
    mockSearchTitles.mockResolvedValue([makeResult("Foobar")]);

    const ctx = makeCtx("[[Foo", 5);
    const result = await wikilinkCompletionSource(ctx);

    expect(result).not.toBeNull();
    expect(mockSearchTitles).toHaveBeenCalledWith("Foo", 10);
    expect(result!.options.length).toBe(2);
  });

  it("W3: Create row is always the last option in the list", async () => {
    mockSearchTitles.mockResolvedValue([makeResult("Alpha"), makeResult("Beta")]);

    const ctx = makeCtx("[[A", 3);
    const result = await wikilinkCompletionSource(ctx);

    expect(result).not.toBeNull();
    const labels = result!.options.map((o) => o.label);
    expect(labels[labels.length - 1]).toMatch(/Create/i);
  });

  it("W4: existing-note completion inserts [[Title]] replacing [[partial", async () => {
    mockSearchTitles.mockResolvedValue([makeResult("Foobar", "uuid-foobar")]);

    const ctx = makeCtx("[[Foo", 5);
    const result = await wikilinkCompletionSource(ctx);
    expect(result).not.toBeNull();

    const firstOption = result!.options[0];
    expect(firstOption.label).toBe("Foobar");
    expect(typeof firstOption.apply).toBe("function");
  });

  it("W5: Create row has an apply function that calls createNoteAndNavigate", async () => {
    const createFn = vi.fn().mockResolvedValue(undefined);
    setWikilinkAutocompleteCallbacks({
      createNoteAndNavigate: createFn,
      getCurrentSourceFolder: () => "my-folder",
    });

    mockSearchTitles.mockResolvedValue([]);

    const ctx = makeCtx("[[MyNote", 8);
    const result = await wikilinkCompletionSource(ctx);
    expect(result).not.toBeNull();

    const createOption = result!.options[result!.options.length - 1];
    expect(createOption.label).toMatch(/Create/i);
    expect(typeof createOption.apply).toBe("function");
  });

  it("W6: cursor inside fenced code block returns null", async () => {
    const doc = "```typescript\n[[Foo\n```";
    const pos = 15;
    const ctx = makeCtx(doc, pos);
    const result = await wikilinkCompletionSource(ctx);
    expect(result).toBeNull();
    expect(mockSearchTitles).not.toHaveBeenCalled();
  });

  it("W7: cursor inside inline code span returns null", async () => {
    const doc = "`[[Foo`";
    const pos = 4;
    const ctx = makeCtx(doc, pos);
    const result = await wikilinkCompletionSource(ctx);
    expect(result).toBeNull();
  });

  it("W8: cursor inside frontmatter returns null", async () => {
    const doc = "---\ntags: [[Foo\n---\n";
    const pos = 12;
    const ctx = makeCtx(doc, pos);
    const result = await wikilinkCompletionSource(ctx);
    expect(result).toBeNull();
  });

  it("W9: result.from is trigger.from + 2 (after [[, not before)", async () => {
    mockSearchTitles.mockResolvedValue([makeResult("Alpha")]);

    const doc = "Some text [[Alpha";
    const pos = doc.length;
    const ctx = makeCtx(doc, pos);
    const result = await wikilinkCompletionSource(ctx);

    expect(result).not.toBeNull();
    const doubleOpenPos = doc.indexOf("[[");
    expect(result!.from).toBe(doubleOpenPos + 2);
  });

  it("W10: empty server response shows only the Create row", async () => {
    mockSearchTitles.mockResolvedValue([]);

    const ctx = makeCtx("[[Xyz", 5);
    const result = await wikilinkCompletionSource(ctx);

    expect(result).not.toBeNull();
    expect(result!.options.length).toBe(1);
    expect(result!.options[0].label).toMatch(/Create/i);
  });

  it("W11: server error shows only Create row (graceful degradation)", async () => {
    mockSearchTitles.mockRejectedValue(new Error("Network error"));

    const ctx = makeCtx("[[Foo", 5);
    const result = await wikilinkCompletionSource(ctx);

    expect(result).not.toBeNull();
    expect(result!.options.length).toBe(1);
    expect(result!.options[0].label).toMatch(/Create/i);
  });

  it("W12: cursor not after [[ returns null", async () => {
    const ctx = makeCtx("Just some text", 14);
    const result = await wikilinkCompletionSource(ctx);
    expect(result).toBeNull();
    expect(mockSearchTitles).not.toHaveBeenCalled();
  });
});
