/**
 * CommandMenu tests — TDD RED phase.
 *
 * Tests cover:
 * - Modal open/close via open prop
 * - mode prop switches icon/placeholder/aria-label
 * - Empty state copy for notes + commands modes
 * - ArrowDown/ArrowUp keyboard navigation changes selected item
 * - Enter activates selected item (note: setActiveNote + recordOpenedNote + close)
 * - Enter activates command (calls action + closes)
 * - Esc closes the dialog (Radix default)
 * - Input focus and query change
 * - Sanitized input doesn't break (XSS-safe)
 * - Bucket B1 (Plan 07-18): FTS5 search triggered at query.length >= 2
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock dependencies
vi.mock("../lib/useFileTree", () => ({
  useFileTree: vi.fn(),
}));

vi.mock("../lib/useTreeStore", () => ({
  useTreeStore: vi.fn(),
}));

vi.mock("../lib/useQuickSwitcher", () => ({
  useQuickSwitcher: vi.fn(),
}));

vi.mock("../lib/useCommandPalette", () => ({
  useCommandPalette: vi.fn(),
}));

// Bucket B1 (Plan 07-18): mock useSearch for FTS5 integration tests.
vi.mock("../lib/useSearch", () => ({
  useSearch: vi.fn(),
}));

// Mock @tanstack/react-virtual — in jsdom there's no measured height, so
// the virtualizer returns 0 items. Replacing with a simple passthrough.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn().mockImplementation(({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        start: i * 36,
        size: 36,
        key: i,
      })),
    getTotalSize: () => count * 36,
    scrollToIndex: vi.fn(),
  })),
}));

import { CommandMenu } from "./CommandMenu";
import { useFileTree } from "../lib/useFileTree";
import { useTreeStore } from "../lib/useTreeStore";
import { useQuickSwitcher } from "../lib/useQuickSwitcher";
import { useCommandPalette } from "../lib/useCommandPalette";
import { useSearch } from "../lib/useSearch";

const mockUseFileTree = useFileTree as unknown as ReturnType<typeof vi.fn>;
const mockUseTreeStore = useTreeStore as unknown as ReturnType<typeof vi.fn>;
const mockUseQuickSwitcher = useQuickSwitcher as unknown as ReturnType<typeof vi.fn>;
const mockUseCommandPalette = useCommandPalette as unknown as ReturnType<typeof vi.fn>;
const mockUseSearch = useSearch as unknown as ReturnType<typeof vi.fn>;

// Default mocks
const mockSetActiveNote = vi.fn();
const mockRecordOpenedNote = vi.fn();

function setupMocks() {
  mockUseFileTree.mockReturnValue({ tree: null, loading: false, error: null });

  // useTreeStore is called with selector functions; mock it to return appropriate values
  mockUseTreeStore.mockImplementation((selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setActiveNote: mockSetActiveNote,
      recordOpenedNote: mockRecordOpenedNote,
      recentlyOpenedNoteIds: [],
      activeTagFilter: null,
      // SearchResultRow still calls these store actions (dead-code per Plan 07-18 HALT gate;
      // they're no-ops in the new architecture but must be present in mock to avoid throws).
      setSearchActive: vi.fn(),
      setSearchQuery: vi.fn(),
      setSearchResults: vi.fn(),
    };
    return selector(state);
  });

  mockUseQuickSwitcher.mockReturnValue([]);
  mockUseCommandPalette.mockReturnValue({
    filtered: vi.fn().mockReturnValue([]),
    // Default: execute returns true (close palette) — matches real useCommandPalette
    // behavior for all commands except switch-note.
    execute: vi.fn().mockReturnValue(true),
  });
  // Bucket B1 default: no FTS5 search results.
  mockUseSearch.mockReturnValue({ results: [], isSearching: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupMocks();
});

// Default props for notes mode
const defaultNoteProps = {
  open: true,
  onOpenChange: vi.fn(),
  mode: "notes" as const,
  actions: {},
};

// Default props for commands mode
const defaultCmdProps = {
  open: true,
  onOpenChange: vi.fn(),
  mode: "commands" as const,
  actions: {},
};

describe("CommandMenu — open/close", () => {
  it("renders dialog content when open=true", () => {
    render(<CommandMenu {...defaultNoteProps} />);
    // Input should be present when open
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("does not render dialog content when open=false", () => {
    render(<CommandMenu {...defaultNoteProps} open={false} />);
    // Input should not be present when closed
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("CommandMenu — mode prop (notes)", () => {
  it("shows 'Switch to note…' placeholder in notes mode", () => {
    render(<CommandMenu {...defaultNoteProps} />);
    expect(screen.getByPlaceholderText("Switch to note…")).toBeTruthy();
  });

  it("shows Quick switcher aria-label in notes mode", () => {
    render(<CommandMenu {...defaultNoteProps} />);
    // The Dialog.Content aria-label should be "Quick switcher"
    expect(screen.getByRole("dialog", { name: "Quick switcher" })).toBeTruthy();
  });
});

describe("CommandMenu — mode prop (commands)", () => {
  it("shows 'Type a command…' placeholder in commands mode", () => {
    render(<CommandMenu {...defaultCmdProps} />);
    expect(screen.getByPlaceholderText("Type a command…")).toBeTruthy();
  });

  it("shows Command palette aria-label in commands mode", () => {
    render(<CommandMenu {...defaultCmdProps} />);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });
});

describe("CommandMenu — empty states (notes mode)", () => {
  it("shows 'Start typing to switch notes' when notes mode + empty query + no results", () => {
    mockUseQuickSwitcher.mockReturnValue([]);
    render(<CommandMenu {...defaultNoteProps} />);
    expect(screen.getByText("Start typing to switch notes")).toBeTruthy();
  });
});

describe("CommandMenu — empty states (commands mode)", () => {
  it("shows 'No commands match \"xyz\"' when commands mode + non-empty query + no results", async () => {
    const mockFiltered = vi.fn().mockReturnValue([]);
    mockUseCommandPalette.mockReturnValue({ filtered: mockFiltered, execute: vi.fn() });

    render(<CommandMenu {...defaultCmdProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "xyz" } });

    expect(screen.getByText('No commands match "xyz"')).toBeTruthy();
  });
});

describe("CommandMenu — notes results + keyboard navigation", () => {
  it("renders note rows when useQuickSwitcher returns results", () => {
    const notes = [
      { id: "n1", title: "Meeting Notes", path: "meeting.md" },
      { id: "n2", title: "Project Plan", path: "project.md" },
    ];
    mockUseQuickSwitcher.mockReturnValue(notes);
    render(<CommandMenu {...defaultNoteProps} />);
    expect(screen.getByText("Meeting Notes")).toBeTruthy();
    expect(screen.getByText("Project Plan")).toBeTruthy();
  });

  it("ArrowDown moves selection to next item", async () => {
    const notes = [
      { id: "n1", title: "First Note", path: "first.md" },
      { id: "n2", title: "Second Note", path: "second.md" },
    ];
    mockUseQuickSwitcher.mockReturnValue(notes);
    render(<CommandMenu {...defaultNoteProps} />);

    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // The second item should now be "selected" (tested via data-selected or style)
    // We can verify by pressing Enter and checking which note was activated
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockSetActiveNote).toHaveBeenCalledWith("n2");
  });

  it("ArrowUp does not go below index 0", async () => {
    const notes = [{ id: "n1", title: "Only Note", path: "only.md" }];
    mockUseQuickSwitcher.mockReturnValue(notes);
    render(<CommandMenu {...defaultNoteProps} />);

    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "ArrowUp" }); // already at 0
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockSetActiveNote).toHaveBeenCalledWith("n1"); // still selects first
  });

  it("Enter activates selected note: calls setActiveNote + recordOpenedNote + onOpenChange(false)", () => {
    const onOpenChange = vi.fn();
    const notes = [{ id: "n1", title: "Meeting Notes", path: "meeting.md" }];
    mockUseQuickSwitcher.mockReturnValue(notes);

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockSetActiveNote).toHaveBeenCalledWith("n1");
    expect(mockRecordOpenedNote).toHaveBeenCalledWith("n1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("CommandMenu — commands results + keyboard navigation", () => {
  it("renders command rows when palette returns results", () => {
    const cmds = [
      { id: "new-note", label: "New note", group: "File", shortcut: "⌘N", inPalette: true, inCheatSheet: true },
      { id: "today", label: "Today", group: "Navigation", shortcut: "⌘⇧D", inPalette: true, inCheatSheet: true },
    ];
    const mockFiltered = vi.fn().mockReturnValue(cmds);
    mockUseCommandPalette.mockReturnValue({ filtered: mockFiltered, execute: vi.fn() });

    render(<CommandMenu {...defaultCmdProps} />);
    expect(screen.getByText("New note")).toBeTruthy();
    expect(screen.getByText("Today")).toBeTruthy();
  });

  it("Enter executes selected command + calls onOpenChange(false)", () => {
    const onOpenChange = vi.fn();
    // execute returns true = "close palette" (the closeOnExecute contract for new-note)
    const mockExecute = vi.fn().mockReturnValue(true);
    const cmds = [
      { id: "new-note", label: "New note", group: "File", inPalette: true, inCheatSheet: true },
    ];
    const mockFiltered = vi.fn().mockReturnValue(cmds);
    mockUseCommandPalette.mockReturnValue({ filtered: mockFiltered, execute: mockExecute });

    render(<CommandMenu {...defaultCmdProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockExecute).toHaveBeenCalledWith("new-note");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("CommandMenu — XSS safety (threat model T-7-31)", () => {
  it("renders query text in empty state copy without XSS (React escapes by default)", () => {
    const mockFiltered = vi.fn().mockReturnValue([]);
    mockUseCommandPalette.mockReturnValue({ filtered: mockFiltered, execute: vi.fn() });

    render(<CommandMenu {...defaultCmdProps} />);
    const input = screen.getByRole("textbox");
    // Attempt XSS payload — React escapes this automatically
    fireEvent.change(input, { target: { value: '<script>alert("xss")</script>' } });

    // The text should be escaped in the DOM (React handles this)
    const emptyState = screen.getByText(/No commands match/);
    expect(emptyState).toBeTruthy();
    // Verify it's rendered as text content, not injected HTML
    expect(emptyState.innerHTML).not.toContain("<script>");
  });
});

describe("CommandMenu — query resets on close", () => {
  it("clears query when open changes to false then true", () => {
    const mockFiltered = vi.fn().mockReturnValue([]);
    mockUseCommandPalette.mockReturnValue({ filtered: mockFiltered, execute: vi.fn().mockReturnValue(true) });

    const { rerender } = render(<CommandMenu {...defaultCmdProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "hello" } });
    expect((input as HTMLInputElement).value).toBe("hello");

    // Close the dialog
    rerender(<CommandMenu {...defaultCmdProps} open={false} />);
    // Reopen — query should be reset
    rerender(<CommandMenu {...defaultCmdProps} open={true} />);
    const newInput = screen.getByRole("textbox");
    expect((newInput as HTMLInputElement).value).toBe("");
  });
});

describe("CommandMenu — activate closeOnExecute behavior (UAT #5)", () => {
  it("Switch note command does NOT call onOpenChange(false) when execute returns false", () => {
    const onOpenChange = vi.fn();
    // switch-note returns false = "keep palette open"
    const mockExecute = vi.fn().mockReturnValue(false);
    const cmds = [
      { id: "switch-note", label: "Switch / search notes", group: "Navigation", inPalette: true, inCheatSheet: true },
    ];
    const mockFiltered = vi.fn().mockReturnValue(cmds);
    mockUseCommandPalette.mockReturnValue({ filtered: mockFiltered, execute: mockExecute });

    render(<CommandMenu {...defaultCmdProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });

    // The action fired
    expect(mockExecute).toHaveBeenCalledWith("switch-note");
    // But the palette stayed open (onOpenChange NOT called with false)
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("New note command DOES call onOpenChange(false) when execute returns true", () => {
    const onOpenChange = vi.fn();
    // new-note returns true = "close palette"
    const mockExecute = vi.fn().mockReturnValue(true);
    const cmds = [
      { id: "new-note", label: "New note", group: "File", inPalette: true, inCheatSheet: true },
    ];
    const mockFiltered = vi.fn().mockReturnValue(cmds);
    mockUseCommandPalette.mockReturnValue({ filtered: mockFiltered, execute: mockExecute });

    render(<CommandMenu {...defaultCmdProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockExecute).toHaveBeenCalledWith("new-note");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Note selection always calls onOpenChange(false) regardless of closeOnExecute", () => {
    const onOpenChange = vi.fn();
    const notes = [{ id: "n1", title: "My Note", path: "my-note.md" }];
    mockUseQuickSwitcher.mockReturnValue(notes);

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockSetActiveNote).toHaveBeenCalledWith("n1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// CMM-mode-reset — query clears on mode change while open (UAT-2 R1-3)
// ──────────────────────────────────────────────────────────────────────────────

describe("CMM-mode-reset — query clears on mode change while open (UAT-2 R1-3)", () => {
  it("resets local query to empty string when paletteMode flips while open", async () => {
    // Arrange: render in commands mode with empty results
    const mockFiltered = vi.fn().mockReturnValue([]);
    mockUseCommandPalette.mockReturnValue({ filtered: mockFiltered, execute: vi.fn() });

    const { rerender } = render(
      <CommandMenu open={true} onOpenChange={vi.fn()} mode="commands" actions={{}} />
    );

    // Type "fi" into the input — palette filters to commands matching "fi"
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "fi" } });
    expect((input as HTMLInputElement).value).toBe("fi");

    // Act: flip mode to "notes" while keeping open=true (switch-note command behavior
    // from Plan 07-17 where closeOnExecute=false keeps the palette open).
    rerender(
      <CommandMenu open={true} onOpenChange={vi.fn()} mode="notes" actions={{}} />
    );

    // Assert: query should now be empty string — the mode change triggered the reset
    const updatedInput = screen.getByRole("textbox");
    expect((updatedInput as HTMLInputElement).value).toBe("");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Bucket B1 (Plan 07-18) — FTS5 backend search at query.length >= 2
// ──────────────────────────────────────────────────────────────────────────────

describe("CommandMenu — Bucket B1: FTS5 search in notes mode (Plan 07-18)", () => {
  const MOCK_SEARCH_RESULT = {
    id: "sr1",
    title: "Hello World",
    path: "hello.md",
    excerpt_html: "<mark>Hello</mark> world",
    matching_tags: [],
    rank: 0,
    modified_at: "2026-05-14T00:00:00Z",
  };

  it("useSearch is called with empty string when query.length < 2", () => {
    // useQuickSwitcher handles the < 2 char case; useSearch receives empty query
    render(<CommandMenu {...defaultNoteProps} />);
    // useSearch should have been called with empty string (mode=notes, query="")
    expect(mockUseSearch).toHaveBeenCalledWith("", null);
  });

  it("renders fuzzysort hits (quick switcher) when query.length < 2", () => {
    const notes = [
      { id: "n1", title: "Meeting Notes", path: "meeting.md" },
    ];
    mockUseQuickSwitcher.mockReturnValue(notes);
    render(<CommandMenu {...defaultNoteProps} />);
    expect(screen.getByText("Meeting Notes")).toBeTruthy();
  });

  it("renders SearchResultRow for each FTS5 hit when query.length >= 2", () => {
    mockUseSearch.mockReturnValue({
      results: [MOCK_SEARCH_RESULT],
      isSearching: false,
    });
    render(<CommandMenu {...defaultNoteProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "he" } });
    // The FTS5 result title should be in the DOM (rendered by SearchResultRow)
    expect(screen.getByText("Hello World")).toBeTruthy();
  });

  it("does NOT render SearchResultRow when query.length is exactly 1 char", () => {
    mockUseSearch.mockReturnValue({ results: [MOCK_SEARCH_RESULT], isSearching: false });
    // Even if useSearch returned results, with query.length=1 we use quickswitcher
    mockUseQuickSwitcher.mockReturnValue([]);
    render(<CommandMenu {...defaultNoteProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "h" } });
    // With no quickswitcher hits and 1-char query, empty state shown
    expect(screen.getByText("Start typing to switch notes")).toBeTruthy();
  });

  it("fires search at query.length exactly 2", () => {
    mockUseSearch.mockReturnValue({
      results: [MOCK_SEARCH_RESULT],
      isSearching: false,
    });
    render(<CommandMenu {...defaultNoteProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "ab" } });
    // With 2-char query, switch to FTS5 path — useSearch was called with "ab"
    expect(mockUseSearch).toHaveBeenCalledWith("ab", null);
    // Result should appear in the DOM
    expect(screen.getByText("Hello World")).toBeTruthy();
  });

  it("Enter on a search-result row calls setActiveNote + recordOpenedNote + closes palette", () => {
    const onOpenChange = vi.fn();
    mockUseSearch.mockReturnValue({
      results: [MOCK_SEARCH_RESULT],
      isSearching: false,
    });
    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    // Type 2+ chars to enter FTS5 mode
    fireEvent.change(input, { target: { value: "he" } });
    // Press Enter on the first (selected) result
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockSetActiveNote).toHaveBeenCalledWith("sr1");
    expect(mockRecordOpenedNote).toHaveBeenCalledWith("sr1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("click on a search-result row calls setActiveNote + recordOpenedNote + closes palette", () => {
    const onOpenChange = vi.fn();
    mockUseSearch.mockReturnValue({
      results: [MOCK_SEARCH_RESULT],
      isSearching: false,
    });
    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "he" } });

    // Click on the result row wrapper (the div containing SearchResultRow)
    const resultTitle = screen.getByText("Hello World");
    // The outer wrapper click triggers activate()
    resultTitle.click();

    expect(mockSetActiveNote).toHaveBeenCalledWith("sr1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// CMM-MERGE-* / CMM-NAV-* / CMM-INIT-* (Plan 07-33)
// UAT-3 N10 + N11: dual-section merge, dedup, non-navigable group eyebrows
// ──────────────────────────────────────────────────────────────────────────────

describe("CMM-MERGE — dual-section title-fuzzy + FTS5 merge (Plan 07-33)", () => {
  const MOCK_TITLE_HIT = { id: "n1", title: "test", path: "test.md" };
  const MOCK_FTS5_HIT = {
    id: "n2",
    title: "alpha",
    path: "alpha.md",
    excerpt_html: "has te...",
    matching_tags: [],
    rank: 1,
    modified_at: "2026-05-15T00:00:00Z",
  };

  it("CMM-MERGE-1: query 'te' with title-fuzzy hit 'test' present → 'test' visible at query.length >= 2", () => {
    // Regression test for UAT-3 N10: title-fuzzy must STILL work at 2+ chars
    mockUseQuickSwitcher.mockReturnValue([MOCK_TITLE_HIT]);
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "te" } });

    // 'test' note must be in the DOM — title-fuzzy merged into items even at 2+ chars
    expect(screen.getByText("test")).toBeTruthy();
  });

  it("CMM-MERGE-2: title hit 'test' + FTS5 hit 'alpha' → both visible with group eyebrows", () => {
    mockUseQuickSwitcher.mockReturnValue([MOCK_TITLE_HIT]);
    mockUseSearch.mockReturnValue({ results: [MOCK_FTS5_HIT], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "te" } });

    // Note title row visible — use getAllByText since 'alpha' may appear in title + path of SearchResultRow
    expect(screen.getByText("test")).toBeTruthy();
    expect(screen.getAllByText(/alpha/i).length).toBeGreaterThan(0);

    // Both group eyebrows visible
    const switchEyebrow = document.querySelector('[data-row-kind="group"][data-group-id="group:notes"]');
    const searchEyebrow = document.querySelector('[data-row-kind="group"][data-group-id="group:search"]');
    expect(switchEyebrow).not.toBeNull();
    expect(searchEyebrow).not.toBeNull();
    expect(switchEyebrow!.textContent).toContain("Switch to note");
    expect(searchEyebrow!.textContent).toContain("Search results");
  });

  it("CMM-MERGE-3: dedup — 'alpha' in both title-fuzzy AND FTS5 → only one entry; only 'Switch to note' eyebrow rendered", () => {
    const dupFTS5Hit = { ...MOCK_FTS5_HIT, id: "n1", title: "alpha" }; // same id as title hit
    const titleHitAlpha = { id: "n1", title: "alpha", path: "alpha.md" };
    mockUseQuickSwitcher.mockReturnValue([titleHitAlpha]);
    mockUseSearch.mockReturnValue({ results: [dupFTS5Hit], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "al" } });

    // Only one 'alpha' row (deduped)
    const alphaElements = screen.getAllByText("alpha");
    // Should only appear in the note row, not duplicated as search-result row
    expect(alphaElements.length).toBeGreaterThan(0);

    // Only "Switch to note" eyebrow — no "Search results" eyebrow (all FTS5 hits were dups)
    const switchEyebrow = document.querySelector('[data-row-kind="group"][data-group-id="group:notes"]');
    const searchEyebrow = document.querySelector('[data-row-kind="group"][data-group-id="group:search"]');
    expect(switchEyebrow).not.toBeNull();
    expect(searchEyebrow).toBeNull(); // deduped → search section absent
  });

  it("CMM-MERGE-4: title-fuzzy empty + FTS5 non-empty → only 'Search results' eyebrow", () => {
    mockUseQuickSwitcher.mockReturnValue([]);
    mockUseSearch.mockReturnValue({ results: [MOCK_FTS5_HIT], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "al" } });

    // Only search eyebrow
    const switchEyebrow = document.querySelector('[data-row-kind="group"][data-group-id="group:notes"]');
    const searchEyebrow = document.querySelector('[data-row-kind="group"][data-group-id="group:search"]');
    expect(switchEyebrow).toBeNull();
    expect(searchEyebrow).not.toBeNull();
    expect(searchEyebrow!.textContent).toContain("Search results");
  });

  it("CMM-MERGE-5: title-fuzzy non-empty + FTS5 empty → only 'Switch to note' eyebrow", () => {
    mockUseQuickSwitcher.mockReturnValue([MOCK_TITLE_HIT]);
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "te" } });

    const switchEyebrow = document.querySelector('[data-row-kind="group"][data-group-id="group:notes"]');
    const searchEyebrow = document.querySelector('[data-row-kind="group"][data-group-id="group:search"]');
    expect(switchEyebrow).not.toBeNull();
    expect(searchEyebrow).toBeNull();
  });

  it("CMM-MERGE-6: both empty + query.length >= 2 → empty state 'No notes match'", () => {
    mockUseQuickSwitcher.mockReturnValue([]);
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "zz" } });

    expect(screen.getByText(/No notes match "zz"/)).toBeTruthy();
  });
});

describe("CMM-NAV — non-navigable group eyebrow rows (Plan 07-33)", () => {
  const MOCK_TITLE_HIT = { id: "n1", title: "test", path: "test.md" };
  const MOCK_FTS5_HIT = {
    id: "n2",
    title: "alpha",
    path: "alpha.md",
    excerpt_html: "has te...",
    matching_tags: [],
    rank: 1,
    modified_at: "2026-05-15T00:00:00Z",
  };

  it("CMM-NAV-1: ArrowDown skips group eyebrows — pressing ArrowDown from initial position skips the 'Switch to note' group to land on the first note row", () => {
    // items list: [group:notes, note:n1, group:search, search:n2]
    mockUseQuickSwitcher.mockReturnValue([MOCK_TITLE_HIT]);
    mockUseSearch.mockReturnValue({ results: [MOCK_FTS5_HIT], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "te" } });

    // After query change, selectedIdx initializes to first selectable (n1, skipping group)
    // Press ArrowDown from n1 → should land on n2 (skipping the group:search eyebrow)
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // Press Enter → should activate n2 (the FTS5 result, skipping the group eyebrow)
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockSetActiveNote).toHaveBeenCalledWith("n2");
  });

  it("CMM-NAV-2: ArrowUp at first selectable does not advance into a non-existent row above", () => {
    mockUseQuickSwitcher.mockReturnValue([MOCK_TITLE_HIT]);
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "te" } });

    // selectedIdx starts at n1 (first selectable, skipping leading group eyebrow)
    fireEvent.keyDown(input, { key: "ArrowUp" }); // can't go up — already at first selectable
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockSetActiveNote).toHaveBeenCalledWith("n1"); // still n1, didn't go negative
  });

  it("CMM-NAV-3: Enter when items is empty is a no-op (defensive — activate returns early on undefined item)", () => {
    // With no notes returned from useQuickSwitcher and no FTS5 hits, items=[] and
    // activate(0) returns early (item = items[0] = undefined → early return).
    mockUseQuickSwitcher.mockReturnValue([]);
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });
    const onOpenChange = vi.fn();

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    // Empty query → items=[] → activate(0) does nothing
    fireEvent.keyDown(input, { key: "Enter" });
    // onOpenChange must NOT be called with false (palette stays open)
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe("CMM-INIT — selectedIdx starts at first selectable (Plan 07-33)", () => {
  it("CMM-INIT-1: when items list rebuilds with leading group eyebrow, selectedIdx starts at first note row (not the group)", () => {
    const MOCK_TITLE_HIT = { id: "n1", title: "test", path: "test.md" };
    mockUseQuickSwitcher.mockReturnValue([MOCK_TITLE_HIT]);
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });
    const onOpenChange = vi.fn();

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    // Type 2+ chars to trigger merge logic with group eyebrow prepended
    fireEvent.change(input, { target: { value: "te" } });

    // Press Enter immediately without ArrowDown — should activate n1 (first selectable),
    // NOT the group eyebrow (which would be a no-op).
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockSetActiveNote).toHaveBeenCalledWith("n1");
  });
});
