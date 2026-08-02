/**
 * calloutFoldField.test.ts — vitest suite for the callout fold StateField
 * (READ-02).
 *
 * Verifies: foldable ("[!type]-") callouts start collapsed on load,
 * toggleCalloutFold flips fold state per-blockquote (position-keyed,
 * multiple independent callouts), folded body lines are hidden via a
 * block Decoration.replace, and non-foldable callouts ("[!type]" without
 * the dash) are never present in the folded set.
 */
import { describe, expect, it, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import {
  calloutFoldExtension,
  toggleCalloutFold,
  isCalloutFolded,
} from "./calloutFoldField";

function makeView(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [markdown(), calloutFoldExtension],
    }),
  });
}

/** Returns true if any decoration in the state's provided set is a block Decoration.replace. */
function hasBlockReplace(view: EditorView): boolean {
  const decos = view.state.facet(EditorView.decorations).map((provider) =>
    typeof provider === "function" ? provider(view) : provider,
  );
  for (const set of decos) {
    const cursor = set.iter();
    while (cursor.value !== null) {
      const spec = (cursor.value as unknown as { spec: Record<string, unknown> }).spec;
      if (spec?.block === true) return true;
      cursor.next();
    }
  }
  return false;
}

describe("calloutFoldField", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const v of views) v.destroy();
    views.length = 0;
  });

  it("a foldable '[!type]-' callout starts collapsed on load", () => {
    const doc = "> [!tip]- Title\n> body line";
    const view = makeView(doc);
    views.push(view);

    expect(isCalloutFolded(view.state, 0)).toBe(true);
    expect(hasBlockReplace(view)).toBe(true);
  });

  it("a non-foldable '[!type]' callout (no dash) is never in the folded set", () => {
    const doc = "> [!tip] Title\n> body line";
    const view = makeView(doc);
    views.push(view);

    expect(isCalloutFolded(view.state, 0)).toBe(false);
    expect(hasBlockReplace(view)).toBe(false);
  });

  it("toggleCalloutFold expands a folded callout (body decoration disappears)", () => {
    const doc = "> [!tip]- Title\n> body line";
    const view = makeView(doc);
    views.push(view);

    expect(isCalloutFolded(view.state, 0)).toBe(true);
    view.dispatch({ effects: toggleCalloutFold.of({ from: 0 }) });
    expect(isCalloutFolded(view.state, 0)).toBe(false);
    expect(hasBlockReplace(view)).toBe(false);
  });

  it("toggleCalloutFold re-collapses an expanded callout (round trip)", () => {
    const doc = "> [!tip]- Title\n> body line";
    const view = makeView(doc);
    views.push(view);

    view.dispatch({ effects: toggleCalloutFold.of({ from: 0 }) });
    expect(isCalloutFolded(view.state, 0)).toBe(false);
    view.dispatch({ effects: toggleCalloutFold.of({ from: 0 }) });
    expect(isCalloutFolded(view.state, 0)).toBe(true);
  });

  it("toggles two independent callouts by their own blockquote start position", () => {
    const doc = "> [!tip]- First\n> body one\n\nAfter.\n\n> [!warning]- Second\n> body two";
    const view = makeView(doc);
    views.push(view);

    const firstFrom = 0;
    const secondFrom = doc.indexOf("> [!warning]");

    expect(isCalloutFolded(view.state, firstFrom)).toBe(true);
    expect(isCalloutFolded(view.state, secondFrom)).toBe(true);

    view.dispatch({ effects: toggleCalloutFold.of({ from: firstFrom }) });
    expect(isCalloutFolded(view.state, firstFrom)).toBe(false);
    expect(isCalloutFolded(view.state, secondFrom)).toBe(true);
  });

  it("a foldable callout with no body lines has no block-replace decoration", () => {
    const doc = "> [!tip]-\n\nAfter.";
    const view = makeView(doc);
    views.push(view);

    expect(isCalloutFolded(view.state, 0)).toBe(true);
    expect(hasBlockReplace(view)).toBe(false);
  });

  it("deleting the trailing dash unfolds the callout and reveals its body (no stranded content)", () => {
    // "> [!tip]- Title" — the fold dash is at index 8. Start collapsed.
    const doc = "> [!tip]- Title\n> body line";
    const view = makeView(doc);
    views.push(view);

    expect(isCalloutFolded(view.state, 0)).toBe(true);
    expect(hasBlockReplace(view)).toBe(true);

    // User deletes the trailing dash → "> [!tip] Title" is no longer foldable.
    view.dispatch({ changes: { from: 8, to: 9 } });

    // The position must be pruned from the folded set, and the body decoration
    // must disappear — otherwise the content is hidden with no chevron to
    // reveal it (the bug this guards against).
    expect(isCalloutFolded(view.state, 0)).toBe(false);
    expect(hasBlockReplace(view)).toBe(false);
  });
});
