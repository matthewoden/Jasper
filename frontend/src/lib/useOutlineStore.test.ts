/**
 * useOutlineStore.test.ts — vitest suite for the Outline Zustand store.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { useOutlineStore } from "./useOutlineStore";
import type { HeadingInfo } from "../editor/outlineExtract";

describe("useOutlineStore", () => {
  beforeEach(() => {
    useOutlineStore.setState({ outlineHeadings: [], scrollToHeading: null });
  });

  it("starts with an empty heading list and null scrollToHeading", () => {
    const state = useOutlineStore.getState();
    expect(state.outlineHeadings).toEqual([]);
    expect(state.scrollToHeading).toBeNull();
  });

  it("setOutlineHeadings updates the heading list", () => {
    const headings: HeadingInfo[] = [
      { level: 1, text: "A", line: 1, from: 0 },
      { level: 2, text: "B", line: 3, from: 4 },
    ];
    useOutlineStore.getState().setOutlineHeadings(headings);
    expect(useOutlineStore.getState().outlineHeadings).toEqual(headings);
  });

  it("setScrollToHeading updates the callback and it is invokable", () => {
    const fn = vi.fn();
    useOutlineStore.getState().setScrollToHeading(fn);
    const stored = useOutlineStore.getState().scrollToHeading;
    expect(stored).toBe(fn);
    stored?.(42);
    expect(fn).toHaveBeenCalledWith(42);
  });

  it("setScrollToHeading(null) clears the callback", () => {
    useOutlineStore.getState().setScrollToHeading(() => {});
    useOutlineStore.getState().setScrollToHeading(null);
    expect(useOutlineStore.getState().scrollToHeading).toBeNull();
  });
});
