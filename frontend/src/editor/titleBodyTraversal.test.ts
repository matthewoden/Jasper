/**
 * titleBodyTraversal.test.ts — vitest suite for firstVisibleBodyLine() and
 * makeTitleBodyTraversalKeymap() (D-18 through D-21).
 *
 * The load-bearing case (RESEARCH Pitfall 2): a doc with BOTH hidden
 * frontmatter AND a hidden first-H1 must skip past both — landing on the
 * first real body line, never the invisible H1 line.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";

import { firstVisibleBodyLine, makeTitleBodyTraversalKeymap } from "./titleBodyTraversal";

const DOC_FRONTMATTER_H1_BODY = `---
tags: [foo]
---
# Title
body line 1
body line 2`;

const DOC_FRONTMATTER_ONLY = `---
tags: [foo]
---
body line 1
body line 2`;

const DOC_H1_ONLY = `# Title
body line 1
body line 2`;

const DOC_NOTHING_BELOW = `---
tags: [foo]
---
# Title`;

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [yamlFrontmatter({ content: markdown() })],
  });
}

function makeView(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({ parent, state: makeState(doc) });
}

describe("firstVisibleBodyLine", () => {
  it("frontmatter + H1 + body: returns 'body line 1', not the frontmatter or the hidden H1 line", () => {
    const state = makeState(DOC_FRONTMATTER_H1_BODY);
    const line = firstVisibleBodyLine(state);
    expect(line).not.toBeNull();
    expect(line!.text).toBe("body line 1");
  });

  it("frontmatter but no H1: returns the first line after frontmatter", () => {
    const state = makeState(DOC_FRONTMATTER_ONLY);
    const line = firstVisibleBodyLine(state);
    expect(line).not.toBeNull();
    expect(line!.text).toBe("body line 1");
  });

  it("H1 but no frontmatter: returns the first line after the H1", () => {
    const state = makeState(DOC_H1_ONLY);
    const line = firstVisibleBodyLine(state);
    expect(line).not.toBeNull();
    expect(line!.text).toBe("body line 1");
  });

  it("nothing below the hidden regions: returns null", () => {
    const state = makeState(DOC_NOTHING_BELOW);
    const line = firstVisibleBodyLine(state);
    expect(line).toBeNull();
  });

  it("doc with no frontmatter and no H1 at all: returns the very first line", () => {
    const state = makeState("just a plain paragraph\nsecond line");
    const line = firstVisibleBodyLine(state);
    expect(line).not.toBeNull();
    expect(line!.text).toBe("just a plain paragraph");
  });
});

describe("makeTitleBodyTraversalKeymap — ArrowUp handoff", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("caret NOT on the first visible line: run() returns false (normal Up), callback not invoked", () => {
    const onCrossToTitle = vi.fn();
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: DOC_FRONTMATTER_H1_BODY,
        extensions: [
          yamlFrontmatter({ content: markdown() }),
          makeTitleBodyTraversalKeymap(onCrossToTitle),
        ],
      }),
    });
    views.push(view);

    const secondLine = view.state.doc.line(
      view.state.doc.lineAt(view.state.doc.toString().indexOf("body line 2")).number,
    );
    view.dispatch({ selection: { anchor: secondLine.from } });

    const handled = dispatchArrowUp(view);
    expect(handled).toBe(false);
    expect(onCrossToTitle).not.toHaveBeenCalled();
  });

  it("caret on the first visible line: run() returns true, invokes the crossover callback with a measured X", () => {
    const onCrossToTitle = vi.fn();
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: DOC_FRONTMATTER_H1_BODY,
        extensions: [
          yamlFrontmatter({ content: markdown() }),
          makeTitleBodyTraversalKeymap(onCrossToTitle),
        ],
      }),
    });
    views.push(view);

    const target = firstVisibleBodyLine(view.state)!;
    view.dispatch({ selection: { anchor: target.from } });

    const handled = dispatchArrowUp(view);
    expect(handled).toBe(true);
    expect(onCrossToTitle).toHaveBeenCalledTimes(1);
    expect(typeof onCrossToTitle.mock.calls[0][0]).toBe("number");
  });

  it("non-empty selection on the first visible line: run() returns false (no-op)", () => {
    const onCrossToTitle = vi.fn();
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: DOC_FRONTMATTER_H1_BODY,
        extensions: [
          yamlFrontmatter({ content: markdown() }),
          makeTitleBodyTraversalKeymap(onCrossToTitle),
        ],
      }),
    });
    views.push(view);

    const target = firstVisibleBodyLine(view.state)!;
    view.dispatch({ selection: { anchor: target.from, head: target.to } });

    const handled = dispatchArrowUp(view);
    expect(handled).toBe(false);
    expect(onCrossToTitle).not.toHaveBeenCalled();
  });
});

/**
 * Dispatch a real "ArrowUp" keydown at view.contentDOM — the same mechanism
 * CM6's own DOM observer uses internally to drive its keymap (mirrors
 * frontmatterHidePlugin.test.ts's pressKey helper).
 */
function dispatchArrowUp(view: EditorView): boolean {
  const event = new KeyboardEvent("keydown", {
    key: "ArrowUp",
    code: "ArrowUp",
    keyCode: 38,
    which: 38,
    cancelable: true,
    bubbles: true,
  });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}
