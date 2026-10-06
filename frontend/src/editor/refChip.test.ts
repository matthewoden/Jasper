import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";

vi.mock("../lib/itemsApi", () => {
  const cache = new Map<string, unknown>();
  return {
    peekItem: (id: string) => cache.get(id),
    resolveItems: vi.fn(async (ids: string[]) => {
      for (const id of ids) if (seeded.has(id)) cache.set(id, seeded.get(id));
      return cache;
    }),
    __cache: cache,
  };
});

const seeded = new Map<string, unknown>();

import { resolveItems } from "../lib/itemsApi";
import * as itemsApi from "../lib/itemsApi";
import { wikilinkPlugin } from "./wikilinkPlugin";
import { setResolvedTitlesSnapshot } from "./wikilinkResolver";
import {
  isRefTarget,
  parseRef,
  noteIdOfRef,
  chipModel,
  RefChipWidget,
  replaceRefInDoc,
  __testing__,
} from "./refChip";
import { findWikiLinkAt } from "./linkClickHandler";

const NOTE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const cache = (itemsApi as unknown as { __cache: Map<string, unknown> }).__cache;

function makeView(doc: string, cursor?: number): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: cursor ?? doc.length },
      extensions: [yamlFrontmatter({ content: markdown() }), wikilinkPlugin],
    }),
  });
}

function chips(view: EditorView): RefChipWidget[] {
  const plugin = view.plugin(wikilinkPlugin);
  const out: RefChipWidget[] = [];
  const cursor = plugin!.decorations.iter();
  while (cursor.value !== null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (cursor.value as any).spec?.widget;
    if (w instanceof RefChipWidget) out.push(w);
    cursor.next();
  }
  return out;
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("ref grammar", () => {
  it("tells references from titles", () => {
    expect(isRefTarget("ado:workitem/12345")).toBe(true);
    expect(isRefTarget("jasper:note/" + NOTE_ID)).toBe(true);
    expect(isRefTarget("file:/tmp/x.pdf")).toBe(true);
    expect(isRefTarget("Meeting Notes")).toBe(false);
    expect(isRefTarget("ADO:workitem/1")).toBe(false);
    expect(isRefTarget("ado:1")).toBe(false);
  });

  it("parses namespace, kind and id", () => {
    expect(parseRef("ado:workitem/12345")).toEqual({ raw: "ado:workitem/12345", namespace: "ado", kind: "workitem", id: "12345" });
    expect(parseRef("file:/tmp/x.pdf")).toMatchObject({ namespace: "file", id: "/tmp/x.pdf" });
    expect(noteIdOfRef("jasper:note/" + NOTE_ID)).toBe(NOTE_ID);
    expect(noteIdOfRef("jasper:blob/sha256-00")).toBeNull();
    expect(noteIdOfRef("ado:workitem/1")).toBeNull();
  });
});

describe("chipModel", () => {
  beforeEach(() => cache.clear());

  it("renders a foreign ref raw before and after resolution", () => {
    expect(chipModel("ado:workitem/1", null)).toMatchObject({ state: "foreign", label: "ado:workitem/1" });
    cache.set("ado:workitem/1", { id: "ado:workitem/1", kind: "foreign", status: "UNKNOWN", title: "ado:workitem/1" });
    expect(chipModel("ado:workitem/1", "the ticket")).toMatchObject({ state: "foreign", label: "the ticket" });
  });

  it("shows a note's current title, muted when unknown, struck when deleted", () => {
    const ref = "jasper:note/" + NOTE_ID;
    expect(chipModel(ref, null)).toMatchObject({ state: "pending", label: ref });
    cache.set(ref, { id: ref, kind: "note", status: "OK", title: "Alpha" });
    expect(chipModel(ref, null)).toMatchObject({ state: "ok", label: "Alpha", icon: "📄" });
    expect(chipModel(ref, "alias")).toMatchObject({ state: "ok", label: "alias" });
    cache.set(ref, { id: ref, kind: "note", status: "UNKNOWN", title: ref });
    expect(chipModel(ref, null).state).toBe("unknown");
    cache.set(ref, { id: ref, kind: "note", status: "DELETED", title: "Old Alpha" });
    expect(chipModel(ref, "alias")).toMatchObject({ state: "deleted", label: "Old Alpha" });
  });
});

describe("ref chips in the editor", () => {
  const views: EditorView[] = [];
  beforeEach(() => {
    cache.clear();
    seeded.clear();
    __testing__.reset();
    vi.mocked(resolveItems).mockClear();
    setResolvedTitlesSnapshot(new Set(), new Map());
  });
  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
    document.body.innerHTML = "";
  });

  it("decorates a reference as a chip and leaves a title link alone", () => {
    const view = makeView("See [[ado:workitem/1|ticket]] and [[Alpha]].\n");
    views.push(view);
    const got = chips(view);
    expect(got).toHaveLength(1);
    expect(got[0].raw).toBe("ado:workitem/1");
    expect(got[0].display).toBe("ticket");
    expect(got[0].model.state).toBe("foreign");
    const dom = got[0].toDOM(view);
    expect(dom.dataset.state).toBe("foreign");
    expect(dom.querySelector(".cm-ref-chip-label")?.textContent).toBe("ticket");
  });

  it("covers the bang of an embed", () => {
    const view = makeView("x ![[jasper:blob/sha256-0123|shot.png]]\n");
    views.push(view);
    const got = chips(view);
    expect(got).toHaveLength(1);
    expect(got[0].embed).toBe(true);
    const plugin = view.plugin(wikilinkPlugin)!;
    const cursor = plugin.decorations.iter();
    expect(cursor.from).toBe(2);
  });

  it("asks for previews once per pass and re-renders when they land", async () => {
    const ref = "jasper:note/" + NOTE_ID;
    seeded.set(ref, { id: ref, kind: "note", status: "OK", title: "Alpha" });
    const view = makeView(`[[${ref}]] and again [[${ref}]]\n`);
    views.push(view);
    expect(chips(view)[0].model.state).toBe("pending");

    await settle();
    expect(resolveItems).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolveItems).mock.calls[0][0]).toEqual([ref]);
    const after = chips(view);
    expect(after.map((c) => c.model.state)).toEqual(["ok", "ok"]);
    expect(after[0].model.label).toBe("Alpha");
    expect(after[0].toDOM(view).dataset.targetId).toBe(NOTE_ID);
  });

  it("keeps raw markup on the cursor's line", () => {
    const view = makeView("[[ado:workitem/1]]\n", 3);
    views.push(view);
    expect(chips(view)).toHaveLength(0);
  });

  it("shows a hover card with title, kind, status and excerpt", () => {
    const ref = "jasper:note/" + NOTE_ID;
    cache.set(ref, { id: ref, kind: "note", status: "OK", title: "Alpha", updated_at: "2026-10-04T12:00:00Z", excerpt: "Alpha body" });
    const view = makeView(`[[${ref}]]\n`);
    views.push(view);
    const dom = chips(view)[0].toDOM(view);
    document.body.appendChild(dom);
    dom.dispatchEvent(new Event("mouseenter"));
    const card = document.querySelector('[data-testid="ref-hover-card"]');
    expect(card?.textContent).toContain("Alpha");
    expect(card?.textContent).toContain("note · ok");
    expect(card?.textContent).toContain("Alpha body");
    dom.dispatchEvent(new Event("mouseleave"));
    expect(document.querySelector('[data-testid="ref-hover-card"]')).toBeNull();
  });

  it("offers a replaced blob's new version and rewrites every occurrence on click", () => {
    const oldRef = "jasper:blob/sha256-old";
    cache.set(oldRef, { id: oldRef, kind: "blob", status: "DELETED", title: "shot.png", replaced_by: "sha256-new" });
    const view = makeView(`![[${oldRef}]] and [[${oldRef}|again]]\nend`);
    views.push(view);
    const chip = chips(view).find((c) => c.raw === oldRef)!;
    const dom = chip.toDOM(view);
    const badge = dom.querySelector<HTMLButtonElement>('[data-testid="ref-chip-replaced"]');
    expect(badge).not.toBeNull();
    badge!.click();
    expect(view.state.doc.toString()).toBe("![[jasper:blob/sha256-new]] and [[jasper:blob/sha256-new|again]]\nend");
  });

  it("shows no replaced badge on a deleted blob with no successor", () => {
    const ref = "jasper:blob/sha256-gone";
    cache.set(ref, { id: ref, kind: "blob", status: "DELETED", title: "gone.png" });
    const view = makeView(`[[${ref}]]\nend`);
    views.push(view);
    const dom = chips(view)[0].toDOM(view);
    expect(dom.querySelector('[data-testid="ref-chip-replaced"]')).toBeNull();
  });

  it("resolves a click target for a note ref and none for a foreign one", () => {
    const ref = "jasper:note/" + NOTE_ID;
    const view = makeView(`[[${ref}]] [[ado:workitem/1]]\n`, 0);
    views.push(view);
    expect(findWikiLinkAt(view, 2)).toMatchObject({ isRef: true, isResolved: true, targetId: NOTE_ID });
    expect(findWikiLinkAt(view, ref.length + 8)).toMatchObject({ isRef: true, isResolved: false, targetId: null });
  });
});

describe("replaceRefInDoc", () => {
  it("leaves a longer ref that shares the old ref as a prefix alone", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "[[jasper:blob/sha256-aaaa]] [[jasper:blob/sha256-aaaabbbb]] ![[jasper:blob/sha256-aaaa|shot]]",
      }),
    });
    replaceRefInDoc(view, "jasper:blob/sha256-aaaa", "jasper:blob/sha256-cccc");
    expect(view.state.doc.toString()).toBe(
      "[[jasper:blob/sha256-cccc]] [[jasper:blob/sha256-aaaabbbb]] ![[jasper:blob/sha256-cccc|shot]]",
    );
    view.destroy();
  });
});
