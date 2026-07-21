/**
 * tagExtract.test.ts — vitest suite for the live-doc tag extractor (TAGS-02).
 * Covers: first-appearance dedup order, fenced-code exclusion, frontmatter
 * exclusion, and heading-line exclusion — mirroring inlineTagPlugin.test.ts's
 * guard coverage but over the pure extractTags(state) function.
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";

import { extractTags } from "./tagExtract";

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [yamlFrontmatter({ content: markdown({ base: markdownLanguage }) })],
  });
}

describe("extractTags", () => {
  it("extracts #tags in first-appearance order, deduped", () => {
    const doc = "text #alpha more #beta and #alpha again\nother line";
    const state = makeState(doc);
    expect(extractTags(state)).toEqual(["alpha", "beta"]);
  });

  it("ignores #word inside a fenced code block", () => {
    const doc = [
      "Normal #real",
      "```",
      "#fake tag here",
      "```",
      "After #another",
    ].join("\n");
    const state = makeState(doc);
    expect(extractTags(state)).toEqual(["real", "another"]);
  });

  it("ignores #word inside a frontmatter block", () => {
    const doc = ["---", 'tags: "#notatag"', "---", "body #realtag"].join("\n");
    const state = makeState(doc);
    expect(extractTags(state)).toEqual(["realtag"]);
  });

  it("ignores a #tag-like token appearing on a heading line", () => {
    const doc = "# Meeting #notes\nbody #realtag";
    const state = makeState(doc);
    expect(extractTags(state)).toEqual(["realtag"]);
  });

  it("returns an empty array when there are no tags", () => {
    const state = makeState("just plain text\n\nmore text\n");
    expect(extractTags(state)).toEqual([]);
  });
});
