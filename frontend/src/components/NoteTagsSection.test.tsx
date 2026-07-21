/**
 * Tests for NoteTagsSection — active note's live-parsed tag chips
 * (Tags tab upper section, TAGS-02).
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/useTagBrowser", () => ({
  useTagBrowser: vi.fn(),
}));

import { useTagBrowser } from "../lib/useTagBrowser";
import { useNoteTagsStore } from "../lib/useNoteTagsFromDoc";
import { useTreeStore } from "../lib/useTreeStore";
import { NoteTagsSection } from "./NoteTagsSection";

const mockedUseTagBrowser = vi.mocked(useTagBrowser);

beforeEach(() => {
  useNoteTagsStore.setState({ noteTags: [] });
  useTreeStore.setState({ sidebarPanel: "notes", searchQuery: "" });
  mockedUseTagBrowser.mockReset();
  mockedUseTagBrowser.mockReturnValue({
    tags: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
});

describe("NoteTagsSection", () => {
  it("orders chips by count-desc with alphabetical ties (Test 1)", () => {
    useNoteTagsStore.setState({ noteTags: ["b", "a"] });
    mockedUseTagBrowser.mockReturnValue({
      tags: [
        { name: "a", count: 3 },
        { name: "b", count: 1 },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<NoteTagsSection activeNoteId="note-1" />);

    const chips = screen.getAllByTestId(/^note-tag-chip-/);
    expect(chips.map((c) => c.dataset.testid)).toEqual([
      "note-tag-chip-a",
      "note-tag-chip-b",
    ]);
  });

  it("renders each chip's count as an inline suffix, not a floating span (Test 2)", () => {
    useNoteTagsStore.setState({ noteTags: ["a"] });
    mockedUseTagBrowser.mockReturnValue({
      tags: [{ name: "a", count: 3 }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<NoteTagsSection activeNoteId="note-1" />);

    const chip = screen.getByTestId("note-tag-chip-a");
    expect(chip.textContent).toContain("3");
    // The count lives inside the chip element itself, not as a sibling span
    // outside the chip button (i.e. it's one of the chip's own children).
    const spans = chip.querySelectorAll("span");
    expect(Array.from(spans).some((s) => s.textContent?.includes("3"))).toBe(true);
  });

  it("clicking a chip seeds a tag: query into the search panel (Test 3)", () => {
    useNoteTagsStore.setState({ noteTags: ["project"] });
    mockedUseTagBrowser.mockReturnValue({
      tags: [{ name: "project", count: 4 }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<NoteTagsSection activeNoteId="note-1" />);

    fireEvent.click(screen.getByTestId("note-tag-chip-project"));

    expect(useTreeStore.getState().sidebarPanel).toBe("search");
    expect(useTreeStore.getState().searchQuery).toBe("tag:project");
  });

  it("shows 'No note open' when there is no active note (Test 4a)", () => {
    render(<NoteTagsSection activeNoteId={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("No note open");
  });

  it("shows 'No tags on this note' when the active note has zero tags (Test 4b)", () => {
    useNoteTagsStore.setState({ noteTags: [] });
    render(<NoteTagsSection activeNoteId="note-1" />);
    expect(screen.getByRole("status")).toHaveTextContent("No tags on this note");
  });
});
