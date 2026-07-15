/**
 * highlightExtension.test.ts — vitest suite for the hand-rolled
 * `==highlight==` lezer-markdown MarkdownConfig extension. Verifies the
 * parseInline delimiter logic by parsing documents through @codemirror/lang-markdown
 * (with the extension wired in) and walking the resulting syntax tree,
 * mirroring the conventions in livePreviewPlugin.test.ts.
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { Highlight } from "./highlightExtension";

function nodeNames(doc: string): string[] {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [Highlight] })],
  });
  const names: string[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      names.push(node.name);
    },
  });
  return names;
}

function findNode(doc: string, name: string): { from: number; to: number } | null {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [Highlight] })],
  });
  let found: { from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === name && !found) {
        found = { from: node.from, to: node.to };
      }
    },
  });
  return found;
}

describe("highlightExtension", () => {
  it("parses ==word== into a Highlight node containing two HighlightMark nodes", () => {
    const doc = "==word==";
    const names = nodeNames(doc);
    expect(names).toContain("Highlight");
    const markCount = names.filter((n) => n === "HighlightMark").length;
    expect(markCount).toBe(2);

    const highlight = findNode(doc, "Highlight");
    expect(highlight).not.toBeNull();
    expect(highlight!.from).toBe(0);
    expect(highlight!.to).toBe(doc.length);
  });

  it("does not open/close a highlight when == is flanked by whitespace on the wrong side", () => {
    // "a == b" — space on both sides of the opening delimiter candidate
    // means it can't open (space after) and can't close (space before).
    const doc = "a == b == c";
    const names = nodeNames(doc);
    expect(names).not.toContain("Highlight");
  });

  it("does not start a highlight on === (three equals)", () => {
    const doc = "===not a highlight===";
    const names = nodeNames(doc);
    expect(names).not.toContain("Highlight");
  });

  it("nests correctly inside StrongEmphasis: **bold ==hl== bold**", () => {
    const doc = "**bold ==hl== bold**";
    const names = nodeNames(doc);
    expect(names).toContain("StrongEmphasis");
    expect(names).toContain("Highlight");

    const strong = findNode(doc, "StrongEmphasis");
    const highlight = findNode(doc, "Highlight");
    expect(strong).not.toBeNull();
    expect(highlight).not.toBeNull();
    // Highlight range must be fully contained within StrongEmphasis's range.
    expect(highlight!.from).toBeGreaterThanOrEqual(strong!.from);
    expect(highlight!.to).toBeLessThanOrEqual(strong!.to);
  });
});
