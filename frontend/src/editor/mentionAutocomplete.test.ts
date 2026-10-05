import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CompletionContext } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";

const searchItemsMock = vi.fn();
vi.mock("../lib/itemsApi", () => ({ searchItems: (...args: unknown[]) => searchItemsMock(...args) }));

import {
  mentionCompletionSource,
  mentionInsertion,
  setMentionIdNoteLinks,
  type ItemSearchHit,
} from "./mentionAutocomplete";

const NOTE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const noteHit: ItemSearchHit = { ref: `jasper:note/${NOTE_ID}`, kind: "note", title: "Roadmap", path: "plans/roadmap.md" };
const blobHit: ItemSearchHit = { ref: "jasper:blob/sha256-0123456789abcdef", kind: "blob", title: "shot.png", path: "attachments/shot.png" };

function ctxFor(doc: string, pos = doc.length, explicit = false): CompletionContext {
  const state = EditorState.create({ doc, extensions: [yamlFrontmatter({ content: markdown() })] });
  return new CompletionContext(state, pos, explicit);
}

beforeEach(() => {
  searchItemsMock.mockReset();
  searchItemsMock.mockResolvedValue([noteHit, blobHit]);
  setMentionIdNoteLinks(false);
});

describe("mentionInsertion", () => {
  it("inserts a title link by default and an id link when the setting is on", () => {
    expect(mentionInsertion(noteHit, false)).toBe("[[Roadmap]]");
    expect(mentionInsertion(noteHit, true)).toBe(`[[jasper:note/${NOTE_ID}|Roadmap]]`);
  });
  it("always embeds a blob by id", () => {
    expect(mentionInsertion(blobHit, false)).toBe("![[jasper:blob/sha256-0123456789abcdef|shot.png]]");
  });
});

describe("mentionCompletionSource", () => {
  it("opens on @ at a word start and searches the typed text", async () => {
    const res = await mentionCompletionSource(ctxFor("See @road"));
    expect(res).not.toBeNull();
    expect(searchItemsMock).toHaveBeenCalledWith("road", 10);
    expect(res!.from).toBe("See @".length);
    expect(res!.options.map((o) => o.label)).toEqual(["Roadmap", "shot.png"]);
  });

  it("stays closed for a bare @, a mid-word @, and code", async () => {
    expect(await mentionCompletionSource(ctxFor("hello @"))).toBeNull();
    expect(await mentionCompletionSource(ctxFor("mail me@exam"))).toBeNull();
    expect(await mentionCompletionSource(ctxFor("`@road`", 6))).toBeNull();
    expect(searchItemsMock).not.toHaveBeenCalled();
  });

  it("replaces the @ text with the chosen reference", async () => {
    const parent = document.createElement("div");
    const view = new EditorView({ parent, state: EditorState.create({ doc: "See @road", extensions: [markdown()] }) });
    const res = await mentionCompletionSource(new CompletionContext(view.state, 9, false));
    const apply = res!.options[0].apply as (v: EditorView, c: unknown, f: number, t: number) => void;
    apply(view, res!.options[0], res!.from, 9);
    expect(view.state.doc.toString()).toBe("See [[Roadmap]]");

    setMentionIdNoteLinks(true);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "See @road" } });
    const res2 = await mentionCompletionSource(new CompletionContext(view.state, 9, false));
    (res2!.options[1].apply as typeof apply)(view, res2!.options[1], res2!.from, 9);
    expect(view.state.doc.toString()).toBe("See ![[jasper:blob/sha256-0123456789abcdef|shot.png]]");
    view.destroy();
  });

  it("stays closed when the search fails", async () => {
    searchItemsMock.mockRejectedValue(new Error("boom"));
    expect(await mentionCompletionSource(ctxFor("@x"))).toBeNull();
  });
});
