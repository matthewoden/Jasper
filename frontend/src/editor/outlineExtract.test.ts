/**
 * outlineExtract.test.ts — vitest suite for the Outline heading extractor.
 * Covers: ATX H1-H6 extraction in document order, fenced-code exclusion,
 * marker stripping, Setext headings, and the empty-document case.
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";

import { extractHeadings } from "./outlineExtract";

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [yamlFrontmatter({ content: markdown({ base: markdownLanguage }) })],
  });
}

describe("extractHeadings", () => {
  it("extracts ATX H1-H3 in document order with correct levels and text", () => {
    const doc = "# A\n\n## B\n\n### C\n";
    const state = makeState(doc);
    const headings = extractHeadings(state);
    expect(headings.map((h) => h.level)).toEqual([1, 2, 3]);
    expect(headings.map((h) => h.text)).toEqual(["A", "B", "C"]);
  });

  it("extracts all six ATX heading levels", () => {
    const doc = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n";
    const state = makeState(doc);
    const headings = extractHeadings(state);
    expect(headings.map((h) => h.level)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(headings.map((h) => h.text)).toEqual([
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
    ]);
  });

  it("excludes a heading-like line inside a fenced code block", () => {
    const doc = "# Real Heading\n\n```\n# Not A Heading\n```\n\n## Also Real\n";
    const state = makeState(doc);
    const headings = extractHeadings(state);
    expect(headings.map((h) => h.text)).toEqual(["Real Heading", "Also Real"]);
    expect(headings.map((h) => h.level)).toEqual([1, 2]);
  });

  it("strips the ATX marker and trailing whitespace from text", () => {
    const doc = "###   Spaced Heading   \n";
    const state = makeState(doc);
    const headings = extractHeadings(state);
    expect(headings).toHaveLength(1);
    expect(headings[0].text).toBe("Spaced Heading");
    expect(headings[0].level).toBe(3);
  });

  it("computes from as the doc offset of the heading line start", () => {
    const doc = "intro text\n\n# Heading\n";
    const state = makeState(doc);
    const headings = extractHeadings(state);
    expect(headings).toHaveLength(1);
    const expectedFrom = doc.indexOf("# Heading");
    expect(headings[0].from).toBe(expectedFrom);
    expect(headings[0].line).toBe(3);
  });

  it("maps Setext H1 (===) and H2 (---) to levels 1 and 2", () => {
    const doc = "Title One\n=========\n\nTitle Two\n---------\n";
    const state = makeState(doc);
    const headings = extractHeadings(state);
    expect(headings.map((h) => h.level)).toEqual([1, 2]);
    expect(headings.map((h) => h.text)).toEqual(["Title One", "Title Two"]);
  });

  it("returns an empty array for an empty document", () => {
    const state = makeState("");
    expect(extractHeadings(state)).toEqual([]);
  });

  it("returns an empty array for a document with no headings", () => {
    const state = makeState("just some plain text\n\nmore text\n");
    expect(extractHeadings(state)).toEqual([]);
  });
});
