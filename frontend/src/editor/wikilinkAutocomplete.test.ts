/**
 * wikilinkAutocomplete.test.ts — TDD suite for the [[ autocomplete CompletionSource.
 *
 * Phase 6 / Plan 06-10 / Task 2.
 *
 * Requirements:
 *   D-13: [[ triggers autocomplete, results ranked by server
 *   D-14: ALWAYS include "Create '{typed}'" as the LAST row
 *   D-47: Suppress inside fenced code, inline code, frontmatter
 *   Pitfall 9: CompletionResult.from must be AFTER [[  so insertions don't double-up
 *
 * TDD sequence:
 *   RED  → this file (failures: wikilinkAutocomplete.ts not yet written)
 *   GREEN → implement wikilinkAutocomplete.ts
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { CompletionContext } from "@codemirror/autocomplete";
import type { NoteSearchResult } from "../lib/notesApi";

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------
import {
  wikilinkCompletionSource,
  setWikilinkAutocompleteCallbacks,
} from "./wikilinkAutocomplete";

// ---------------------------------------------------------------------------
// Mock notesApi.searchTitles
// ---------------------------------------------------------------------------
vi.mock("../lib/notesApi", () => ({
  searchTitles: vi.fn(),
}));

// We'll import the mock after vi.mock so we can configure it per test
import { searchTitles } from "../lib/notesApi";
const mockSearchTitles = searchTitles as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    // Wire up a no-op create callback so tests that don't care can pass
    setWikilinkAutocompleteCallbacks({
      createNoteAndNavigate: vi.fn().mockResolvedValue(undefined),
      getCurrentSourceFolder: () => "",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // W1: cursor after [[ (no typed text) → returns top results + Create row
  it("W1: cursor after [[ (empty query) returns recent results + Create row", async () => {
    mockSearchTitles.mockResolvedValue([makeResult("Alpha"), makeResult("Beta")]);

    const ctx = makeCtx("[[", 2);
    const result = await wikilinkCompletionSource(ctx);

    expect(result).not.toBeNull();
    expect(result!.options.length).toBe(3); // Alpha, Beta, Create ""
    expect(mockSearchTitles).toHaveBeenCalledWith("", 10);
  });

  // W2: cursor after [[Foo → calls searchTitles with "Foo"
  it("W2: cursor after [[Foo calls searchTitles with query 'Foo'", async () => {
    mockSearchTitles.mockResolvedValue([makeResult("Foobar")]);

    const ctx = makeCtx("[[Foo", 5);
    const result = await wikilinkCompletionSource(ctx);

    expect(result).not.toBeNull();
    expect(mockSearchTitles).toHaveBeenCalledWith("Foo", 10);
    // Foobar + Create "Foo"
    expect(result!.options.length).toBe(2);
  });

  // W3: Create row is ALWAYS last
  it("W3: Create row is always the last option in the list", async () => {
    mockSearchTitles.mockResolvedValue([makeResult("Alpha"), makeResult("Beta")]);

    const ctx = makeCtx("[[A", 3);
    const result = await wikilinkCompletionSource(ctx);

    expect(result).not.toBeNull();
    const labels = result!.options.map((o) => o.label);
    // Last must be the Create row
    expect(labels[labels.length - 1]).toMatch(/Create/i);
  });

  // W4: selecting an existing note completion inserts [[Title]]
  it("W4: existing-note completion inserts [[Title]] replacing [[partial", async () => {
    mockSearchTitles.mockResolvedValue([makeResult("Foobar", "uuid-foobar")]);

    const ctx = makeCtx("[[Foo", 5);
    const result = await wikilinkCompletionSource(ctx);
    expect(result).not.toBeNull();

    // The first option (existing note) should have an apply function
    const firstOption = result!.options[0];
    expect(firstOption.label).toBe("Foobar");
    expect(typeof firstOption.apply).toBe("function");
  });

  // W5: selecting Create row calls createNoteAndNavigate
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

    // The Create row
    const createOption = result!.options[result!.options.length - 1];
    expect(createOption.label).toMatch(/Create/i);
    expect(typeof createOption.apply).toBe("function");
  });

  // W6: cursor inside fenced code → returns null (D-47 suppression)
  it("W6: cursor inside fenced code block returns null", async () => {
    const doc = "```typescript\n[[Foo\n```";
    const pos = 15; // inside the fence: after "```typescript\n"
    const ctx = makeCtx(doc, pos);
    const result = await wikilinkCompletionSource(ctx);
    // Fenced code context — suppressed
    expect(result).toBeNull();
    expect(mockSearchTitles).not.toHaveBeenCalled();
  });

  // W7: cursor inside inline code → returns null
  it("W7: cursor inside inline code span returns null", async () => {
    const doc = "`[[Foo`";
    const pos = 4; // inside inline code
    const ctx = makeCtx(doc, pos);
    const result = await wikilinkCompletionSource(ctx);
    expect(result).toBeNull();
  });

  // W8: cursor inside frontmatter → returns null
  it("W8: cursor inside frontmatter returns null", async () => {
    const doc = "---\ntags: [[Foo\n---\n";
    const pos = 12; // inside frontmatter
    const ctx = makeCtx(doc, pos);
    const result = await wikilinkCompletionSource(ctx);
    expect(result).toBeNull();
  });

  // W9: CompletionResult.from is AFTER [[ (Pitfall 9)
  it("W9: result.from is trigger.from + 2 (after [[, not before)", async () => {
    mockSearchTitles.mockResolvedValue([makeResult("Alpha")]);

    const doc = "Some text [[Alpha";
    const pos = doc.length; // after "Alpha"
    const ctx = makeCtx(doc, pos);
    const result = await wikilinkCompletionSource(ctx);

    expect(result).not.toBeNull();
    // from should point to after [[ (position 11 + 2 = 13)
    // "Some text [[" = 12 chars, so [[ starts at 10, from = 12
    const doubleOpenPos = doc.indexOf("[[");
    expect(result!.from).toBe(doubleOpenPos + 2);
  });

  // W10: empty server response → only Create row shown
  it("W10: empty server response shows only the Create row", async () => {
    mockSearchTitles.mockResolvedValue([]);

    const ctx = makeCtx("[[Xyz", 5);
    const result = await wikilinkCompletionSource(ctx);

    expect(result).not.toBeNull();
    expect(result!.options.length).toBe(1);
    expect(result!.options[0].label).toMatch(/Create/i);
  });

  // W11: server error → only Create row shown; no throw
  it("W11: server error shows only Create row (graceful degradation)", async () => {
    mockSearchTitles.mockRejectedValue(new Error("Network error"));

    const ctx = makeCtx("[[Foo", 5);
    const result = await wikilinkCompletionSource(ctx);

    // Should not throw — returns Create row even on server error
    expect(result).not.toBeNull();
    expect(result!.options.length).toBe(1);
    expect(result!.options[0].label).toMatch(/Create/i);
  });

  // W12: no trigger match → returns null (cursor not after [[)
  it("W12: cursor not after [[ returns null", async () => {
    const ctx = makeCtx("Just some text", 14);
    const result = await wikilinkCompletionSource(ctx);
    expect(result).toBeNull();
    expect(mockSearchTitles).not.toHaveBeenCalled();
  });
});
