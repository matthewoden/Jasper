/**
 * useNoteTagsFromDoc.test.ts — vitest suite for the live note-tags Zustand
 * store (TAGS-02). Mirrors useOutlineStore.test.ts's coverage.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { useNoteTagsStore } from "./useNoteTagsFromDoc";

describe("useNoteTagsStore", () => {
  beforeEach(() => {
    useNoteTagsStore.setState({ noteTags: [] });
  });

  it("starts with an empty tag list", () => {
    expect(useNoteTagsStore.getState().noteTags).toEqual([]);
  });

  it("setNoteTags updates the tag list and a subscriber reads it", () => {
    let observed: string[] = [];
    const unsubscribe = useNoteTagsStore.subscribe((state) => {
      observed = state.noteTags;
    });

    useNoteTagsStore.getState().setNoteTags(["alpha", "beta"]);

    expect(useNoteTagsStore.getState().noteTags).toEqual(["alpha", "beta"]);
    expect(observed).toEqual(["alpha", "beta"]);

    unsubscribe();
  });
});
