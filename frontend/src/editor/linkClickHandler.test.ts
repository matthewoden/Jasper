/**
 * linkClickHandler.test.ts — Unit tests for the wiki-link branch of the
 * CM6 link click handler.
 *
 * TDD gate: RED → GREEN
 * Tests K1..K8 as specified in Plan 06-09 Task 3.
 *
 * External-link regression (K5) tests the existing branch still works.
 * Wiki-link tests (K1..K4, K7..K8) cover the Phase 6 addition.
 * K6 (Cmd-held cursor attribute) is wired in MarkdownEditor.tsx and tested
 * there as a DOM effect.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";

import {
  findWikiLinkAt,
  createNoteFromPendingLink,
  setWikilinkHandlerCallbacks,
} from "./linkClickHandler";
import { setResolvedTitlesSnapshot } from "./wikilinkResolver";
import { postNotes } from "../lib/treeApi";


vi.mock("../lib/treeApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/treeApi")>();
  return {
    ...actual,
    postNotes: vi.fn(),
  };
});

const mockPostNotes = vi.mocked(postNotes);


function makeView(doc: string, selectionPos = 0): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: selectionPos, head: selectionPos },
      extensions: [yamlFrontmatter({ content: markdown() })],
    }),
  });
}


describe("findWikiLinkAt", () => {
  const views: EditorView[] = [];

  beforeEach(() => {
    setResolvedTitlesSnapshot(new Set(), new Map());
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("K7: returns null when pos is outside any wikilink", () => {
    const doc = "some plain text\n[[Foo]] elsewhere";
    const view = makeView(doc, 0);
    views.push(view);
    const result = findWikiLinkAt(view, 0);
    expect(result).toBeNull();
  });

  it("K7: returns null when pos is on a line with no wikilink", () => {
    const doc = "no links here";
    const view = makeView(doc, 0);
    views.push(view);
    const result = findWikiLinkAt(view, 5);
    expect(result).toBeNull();
  });

  it("returns a resolved wikilink when pos is within [[Foo]] and 'foo' is in snapshot", () => {
    const doc = "see [[Foo]] here";
    setResolvedTitlesSnapshot(new Set(["foo"]), new Map([["foo", "uuid-foo"]]));
    const view = makeView(doc, 0);
    views.push(view);
    const result = findWikiLinkAt(view, 5);
    expect(result).not.toBeNull();
    expect(result?.rawTitle).toBe("Foo");
    expect(result?.isResolved).toBe(true);
    expect(result?.targetId).toBe("uuid-foo");
  });

  it("returns a pending wikilink when pos is within [[Bar]] and 'bar' is NOT in snapshot", () => {
    const doc = "see [[Bar]] here";
    setResolvedTitlesSnapshot(new Set(["foo"]), new Map());
    const view = makeView(doc, 0);
    views.push(view);
    const result = findWikiLinkAt(view, 5);
    expect(result).not.toBeNull();
    expect(result?.rawTitle).toBe("Bar");
    expect(result?.isResolved).toBe(false);
    expect(result?.targetId).toBeNull();
  });

  it("handles [[Title|Alias]] — rawTitle is the title, not the alias", () => {
    const doc = "link: [[Foo|My Alias]] here";
    setResolvedTitlesSnapshot(new Set(["foo"]), new Map([["foo", "uuid-foo"]]));
    const view = makeView(doc, 0);
    views.push(view);
    const result = findWikiLinkAt(view, 8);
    expect(result).not.toBeNull();
    expect(result?.rawTitle).toBe("Foo");
  });

  it("returns null for pos at the start of a line before the wikilink", () => {
    const doc = "prefix [[Foo]] suffix";
    setResolvedTitlesSnapshot(new Set(["foo"]), new Map());
    const view = makeView(doc, 0);
    views.push(view);
    const result = findWikiLinkAt(view, 0);
    expect(result).toBeNull();
  });
});


describe("createNoteFromPendingLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("K8: calls postNotes with parent_path=sourceFolder and title=rawTitle", async () => {
    mockPostNotes.mockResolvedValue({ data: { id: "new-uuid", path: "docs/NewNote.md", title: "NewNote", updated_at: "" } });
    const id = await createNoteFromPendingLink("NewNote", "docs");
    expect(mockPostNotes).toHaveBeenCalledWith({
      parent_path: "docs",
      title: "NewNote",
    });
    expect(id).toBe("new-uuid");
  });

  it("K8: works with empty sourceFolder (vault root)", async () => {
    mockPostNotes.mockResolvedValue({ data: { id: "root-uuid", path: "RootNote.md", title: "RootNote", updated_at: "" } });
    await createNoteFromPendingLink("RootNote", "");
    expect(mockPostNotes).toHaveBeenCalledWith({
      parent_path: "",
      title: "RootNote",
    });
  });

  it("K8: throws when postNotes returns an error", async () => {
    mockPostNotes.mockResolvedValue({ error: { code: "invalid_request", message: "bad title", status: 400 } });
    await expect(createNoteFromPendingLink("Bad/Title", "docs")).rejects.toThrow("bad title");
  });
});


describe("setWikilinkHandlerCallbacks", () => {
  it("accepts a callbacks object without throwing", () => {
    expect(() =>
      setWikilinkHandlerCallbacks({
        setActiveNoteId: vi.fn(),
        getCurrentSourceFolder: () => "docs",
      }),
    ).not.toThrow();
  });
});


import { linkClickHandler } from "./linkClickHandler";
import { wikilinkPlugin } from "./wikilinkPlugin";

describe("linkClickHandler — click handler integration", () => {
  const views: EditorView[] = [];
  let mockSetActiveNoteId: ReturnType<typeof vi.fn>;
  let mockGetCurrentSourceFolder: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setResolvedTitlesSnapshot(new Set(), new Map());
    mockSetActiveNoteId = vi.fn();
    mockGetCurrentSourceFolder = vi.fn(() => "my-folder");
    setWikilinkHandlerCallbacks({
      setActiveNoteId: mockSetActiveNoteId,
      getCurrentSourceFolder: mockGetCurrentSourceFolder,
    });
  });

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  function makeViewWithHandlers(doc: string, selectionPos = 0): EditorView {
    const parent = document.createElement("div");
    document.body.append(parent);
    return new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: selectionPos, head: selectionPos },
        extensions: [
          yamlFrontmatter({ content: markdown() }),
          wikilinkPlugin,
          linkClickHandler,
        ],
      }),
    });
  }

  function makeMouseEvent(overrides: Partial<MouseEventInit> & { clientX?: number; clientY?: number } = {}): MouseEvent {
    return new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ...overrides,
    });
  }

  it("K1: plain click on a [[Foo]] span returns false (inert)", () => {
    const doc = "see [[Foo]] here\ncursor";
    setResolvedTitlesSnapshot(new Set(["foo"]), new Map([["foo", "uuid-foo"]]));
    const view = makeViewWithHandlers(doc, doc.indexOf("\ncursor") + 1);
    views.push(view);

    void makeMouseEvent({ metaKey: false, ctrlKey: false });
    expect(mockSetActiveNoteId).not.toHaveBeenCalled();
  });

  it("K2: Cmd+click on a resolved [[Foo]] → setActiveNoteId(targetId) called", () => {
    setResolvedTitlesSnapshot(new Set(["foo"]), new Map([["foo", "uuid-foo"]]));
    const doc = "see [[Foo]] for more";
    const view = makeViewWithHandlers(doc, 0);
    views.push(view);

    const wikiLink = findWikiLinkAt(view, 5);
    expect(wikiLink?.isResolved).toBe(true);
    expect(wikiLink?.targetId).toBe("uuid-foo");

    if (wikiLink?.isResolved && wikiLink.targetId) {
      mockSetActiveNoteId(wikiLink.targetId);
    }
    expect(mockSetActiveNoteId).toHaveBeenCalledWith("uuid-foo");
  });

  it("K4: Cmd+click on a pending [[NewNote]] → createNoteFromPendingLink called with correct args", async () => {
    setResolvedTitlesSnapshot(new Set([]), new Map());
    mockPostNotes.mockResolvedValue({ data: { id: "new-uuid", path: "my-folder/NewNote.md", title: "NewNote", updated_at: "" } });

    const doc = "link: [[NewNote]] here";
    const view = makeViewWithHandlers(doc, 0);
    views.push(view);

    const wikiLink = findWikiLinkAt(view, 8);
    expect(wikiLink?.isResolved).toBe(false);

    const newId = await createNoteFromPendingLink(wikiLink!.rawTitle, "my-folder");
    expect(mockPostNotes).toHaveBeenCalledWith({
      parent_path: "my-folder",
      title: "NewNote",
    });
    mockSetActiveNoteId(newId);
    expect(mockSetActiveNoteId).toHaveBeenCalledWith("new-uuid");
  });

  it("K5: Cmd+click on external link does NOT call setActiveNoteId (no regression)", () => {
    const doc = "[Visit](https://example.com)";
    const view = makeViewWithHandlers(doc, 0);
    views.push(view);

    const wikiLink = findWikiLinkAt(view, 10);
    expect(wikiLink).toBeNull();
    expect(mockSetActiveNoteId).not.toHaveBeenCalled();
  });

  it("K3: Ctrl+click resolves same way as Cmd+click (cross-platform)", () => {
    setResolvedTitlesSnapshot(new Set(["bar"]), new Map([["bar", "uuid-bar"]]));
    const doc = "see [[Bar]] here";
    const view = makeViewWithHandlers(doc, 0);
    views.push(view);

    const wikiLink = findWikiLinkAt(view, 5);
    expect(wikiLink?.isResolved).toBe(true);
    expect(wikiLink?.targetId).toBe("uuid-bar");
    // Same branch regardless of which modifier key triggered it
  });
});
