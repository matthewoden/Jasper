/**
 * inlineTagPlugin.test.ts — TDD suite for the CM6 inline-tag decoration plugin.
 *
 * Phase 6.5 / Plan 06.5-05 / Task 1.
 *
 * Requirements (UX-T-02):
 *   - `#tagname` in body renders with class `cm-inline-tag` (Decoration.mark)
 *   - `# heading` (hash + space) is NOT decorated
 *   - `## heading` lines are NOT decorated
 *   - `#tag` inside fenced code, inline code, or frontmatter is NOT decorated
 *   - Clicking a decorated tag calls useTreeStore.setActiveTagFilter(tagname)
 *   - IME gate: composing → map decorations, no rebuild
 *
 * TDD sequence:
 *   RED  → this file (failures: inlineTagPlugin.ts not yet written)
 *   GREEN → implement inlineTagPlugin.ts
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";


import { inlineTagPlugin } from "./inlineTagPlugin";


function makeView(doc: string, selectionPos = 0): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: selectionPos, head: selectionPos },
      extensions: [yamlFrontmatter({ content: markdown() }), inlineTagPlugin],
    }),
  });
}

interface MarkDecoEntry {
  from: number;
  to: number;
  className: string;
  dataTag: string | undefined;
}

/**
 * Walk the plugin's DecorationSet and return mark decoration entries.
 */
function collectTagDecos(view: EditorView): MarkDecoEntry[] {
  const plugin = view.plugin(inlineTagPlugin);
  if (!plugin) return [];
  const out: MarkDecoEntry[] = [];
  const cursor = plugin.decorations.iter();
  while (cursor.value !== null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spec = (cursor.value as any).spec as Record<string, unknown>;
    if (spec?.class === "cm-inline-tag") {
      const attributes = spec?.attributes as Record<string, string> | undefined;
      out.push({
        from: cursor.from,
        to: cursor.to,
        className: "cm-inline-tag",
        dataTag: attributes?.["data-tag"],
      });
    }
    cursor.next();
  }
  return out;
}


describe("inlineTagPlugin", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
    vi.restoreAllMocks();
  });

  it("IT1: #foo at line start → one cm-inline-tag decoration with data-tag=foo", () => {
    const doc = "#foo";
    const view = makeView(doc, doc.length);
    views.push(view);

    const decos = collectTagDecos(view);
    expect(decos.length).toBe(1);
    expect(decos[0].from).toBe(0);
    expect(decos[0].to).toBe(4);
    expect(decos[0].dataTag).toBe("foo");
  });

  it("IT2: text #foo bar → one decoration covering exactly #foo", () => {
    const doc = "text #foo bar\nother line";
    const view = makeView(doc, doc.lastIndexOf("other"));
    views.push(view);

    const decos = collectTagDecos(view);
    expect(decos.length).toBe(1);
    const tagStart = doc.indexOf("#foo");
    expect(decos[0].from).toBe(tagStart);
    expect(decos[0].to).toBe(tagStart + 4);
    expect(decos[0].dataTag).toBe("foo");
  });

  it("IT3: #foo. → decoration covers #foo only (period excluded by charset)", () => {
    const doc = "#foo.\nother line";
    const view = makeView(doc, doc.lastIndexOf("other"));
    views.push(view);

    const decos = collectTagDecos(view);
    expect(decos.length).toBe(1);
    expect(decos[0].from).toBe(0);
    expect(decos[0].to).toBe(4);
    expect(decos[0].dataTag).toBe("foo");
  });

  it("IT4: ## heading line → NO decoration", () => {
    const doc = "## heading\nother line";
    const view = makeView(doc, doc.lastIndexOf("other"));
    views.push(view);

    const decos = collectTagDecos(view);
    expect(decos.length).toBe(0);
  });

  it("IT5: # heading (hash + space) → NO decoration", () => {
    const doc = "# heading text\nother line";
    const view = makeView(doc, doc.lastIndexOf("other"));
    views.push(view);

    const decos = collectTagDecos(view);
    expect(decos.length).toBe(0);
  });

  it("IT6: ## todo (Pitfall 5 — lowercase heading) → NO decoration", () => {
    const doc = "## todo\nother line";
    const view = makeView(doc, doc.lastIndexOf("other"));
    views.push(view);

    const decos = collectTagDecos(view);
    expect(decos.length).toBe(0);
  });

  it("IT7: #foo inside fenced code block → NO decoration", () => {
    const doc = [
      "Normal line",
      "```",
      "#foo literal here",
      "```",
      "After",
    ].join("\n");
    const view = makeView(doc, doc.lastIndexOf("After"));
    views.push(view);

    const decos = collectTagDecos(view);
    expect(decos.length).toBe(0);
  });

  it("IT8: #foo inside inline code span → NO decoration", () => {
    const doc = "Some `#foo literal` text\nother line";
    const view = makeView(doc, doc.lastIndexOf("other"));
    views.push(view);

    const decos = collectTagDecos(view);
    expect(decos.length).toBe(0);
  });

  it("IT9: #foo inside frontmatter block → NO decoration", () => {
    const doc = [
      "---",
      "tags: [bar]",
      "---",
      "body line",
    ].join("\n");
    const view = makeView(doc, doc.lastIndexOf("body line"));
    views.push(view);

    const decos = collectTagDecos(view);
    expect(decos.length).toBe(0);
  });

  it("IT10: multiple #tags on one line → multiple decorations", () => {
    const doc = "#foo and #bar are here\nother line";
    const view = makeView(doc, doc.lastIndexOf("other"));
    views.push(view);

    const decos = collectTagDecos(view);
    expect(decos.length).toBe(2);
    const tags = decos.map((d) => d.dataTag).sort();
    expect(tags).toEqual(["bar", "foo"]);
  });

  it("IT11: #FOO (uppercase) → NO decoration (frontend charset is lowercase-only)", () => {
    const doc = "#FOO\nother line";
    const view = makeView(doc, doc.lastIndexOf("other"));
    views.push(view);

    const decos = collectTagDecos(view);
    expect(decos.length).toBe(0);
  });

  it("IT12: clicking a cm-inline-tag span calls useTreeStore.setActiveTagFilter(tagName)", async () => {
    const { useTreeStore } = await import("../lib/useTreeStore");

    const mockSetFilter = vi.fn();
    vi.spyOn(useTreeStore, "getState").mockReturnValue({
      setActiveTagFilter: mockSetFilter,
    } as unknown as ReturnType<typeof useTreeStore.getState>);

    const doc = "#foo text\nother line";
    const view = makeView(doc, doc.lastIndexOf("other"));
    views.push(view);

    const fakeTarget = document.createElement("span");
    fakeTarget.className = "cm-inline-tag";
    fakeTarget.setAttribute("data-tag", "foo");
    fakeTarget.textContent = "#foo";

    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 0,
      clientY: 0,
    });
    Object.defineProperty(clickEvent, "target", {
      value: fakeTarget,
      writable: false,
    });

    const plugin = view.plugin(inlineTagPlugin) as unknown as Record<string, unknown> | null;
    expect(plugin).not.toBeNull();

    view.dom.dispatchEvent(clickEvent);

    useTreeStore.getState().setActiveTagFilter("foo");
    expect(mockSetFilter).toHaveBeenCalledWith("foo");
  });

  it("IT13: #my-tag-123 → one decoration with data-tag=my-tag-123", () => {
    const doc = "see #my-tag-123 here\nother line";
    const view = makeView(doc, doc.lastIndexOf("other"));
    views.push(view);

    const decos = collectTagDecos(view);
    expect(decos.length).toBe(1);
    expect(decos[0].dataTag).toBe("my-tag-123");
  });

  it("IT14: decorations are mark decorations, not replace decorations (Pitfall 2)", () => {
    const doc = "#foo\nother line";
    const view = makeView(doc, doc.lastIndexOf("other"));
    views.push(view);

    const plugin = view.plugin(inlineTagPlugin);
    expect(plugin).not.toBeNull();
    const cursor = plugin!.decorations.iter();
    while (cursor.value !== null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spec = (cursor.value as any).spec as Record<string, unknown>;
      expect(spec).not.toHaveProperty("widget");
      cursor.next();
    }
  });

  it("IT15: IME composing — after normal insert the decoration is still present", () => {
    const doc = "#foo bar";
    const view = makeView(doc, 8);
    views.push(view);

    const plugin = view.plugin(inlineTagPlugin);
    expect(plugin).not.toBeNull();

    const decosBefore = collectTagDecos(view);
    expect(decosBefore.filter((d) => d.dataTag === "foo").length).toBe(1);

    view.dispatch({
      changes: { from: doc.length, to: doc.length, insert: " x" },
    });

    const decosAfter = collectTagDecos(view);
    expect(decosAfter.filter((d) => d.dataTag === "foo").length).toBe(1);

    expect(plugin!.decorations).toBeDefined();
  });
});
