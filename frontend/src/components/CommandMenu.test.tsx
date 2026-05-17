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
// Bucket B1 / CMM-MERGE / CMM-N11 / CMM-NAV — REMOVED in Plan 07-39 (UAT-5 N11).
//
// The Plan 07-18 "FTS5 in Cmd+O palette" pivot, the Plan 07-33 dual-section
// merge, and the Plan 07-38 no-dedupe extension are all REVERSED. CommandMenu
// is now title-fuzzy only in notes mode. FTS5 search lives at the Sidebar
// surface (SearchInputBar + SearchResultsList).
//
// The single-section behavior is now covered by CMM-N11-SPLIT-* above.
// ──────────────────────────────────────────────────────────────────────────────

describe("CMM-NAV — single-section navigation (post Plan 07-39 split)", () => {
  const MOCK_TITLE_HIT = { id: "n1", title: "test", path: "test.md" };

  it("CMM-NAV-2: ArrowUp at first selectable does not advance into a non-existent row above", () => {
    mockUseQuickSwitcher.mockReturnValue([MOCK_TITLE_HIT]);

    render(<CommandMenu {...defaultNoteProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "te" } });

    // Single-section list: selectedIdx starts at n1 (first selectable).
    fireEvent.keyDown(input, { key: "ArrowUp" }); // can't go up — already at first
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockSetActiveNote).toHaveBeenCalledWith("n1"); // still n1, didn't go negative
  });

  it("CMM-NAV-3: Enter when items is empty is a no-op (defensive)", () => {
    mockUseQuickSwitcher.mockReturnValue([]);
    const onOpenChange = vi.fn();

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe("CMM-INIT — selectedIdx starts at first selectable (post Plan 07-39 split)", () => {
  it("CMM-INIT-1: pressing Enter immediately without ArrowDown activates the first note row", () => {
    const MOCK_TITLE_HIT = { id: "n1", title: "test", path: "test.md" };
    mockUseQuickSwitcher.mockReturnValue([MOCK_TITLE_HIT]);
    const onOpenChange = vi.fn();

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "te" } });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockSetActiveNote).toHaveBeenCalledWith("n1");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// CMM-N11-SPLIT — Plan 07-39 (UAT-5 N11) — strip FTS5 from switcher
//
// Plan 07-39 REVERSES Plan 07-33's title-fuzzy + FTS5 merge and Plan 07-38's
// dedupe-removal. The switcher is now title-fuzzy ONLY in notes mode. FTS5
// search lives at the Sidebar surface, not in CommandMenu.
// ──────────────────────────────────────────────────────────────────────────────

describe("CMM-N11-SPLIT — switcher is title-fuzzy only (Plan 07-39 / UAT-5 N11)", () => {
  const TITLE_HIT = { id: "n1", title: "alpha", path: "alpha.md" };
  const FTS5_HIT = {
    id: "n2",
    title: "beta",
    path: "beta.md",
    excerpt_html: "body has <mark>al</mark>pha",
    matching_tags: [],
    rank: 1,
    modified_at: "2026-05-16T00:00:00Z",
  };

  it("CMM-N11-SPLIT-1: notes mode never renders a 'Search results' group label", () => {
    mockUseQuickSwitcher.mockReturnValue([TITLE_HIT]);
    // Even if useSearch returns hits, the switcher should NOT render the Search section.
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "al" } });

    // No 'Search results' eyebrow.
    const searchEyebrow = document.querySelector(
      '[data-row-kind="group"][data-group-id="group:search"]',
    );
    expect(searchEyebrow).toBeNull();
    // No 'Search results' text anywhere.
    expect(screen.queryByText("Search results")).toBeNull();
  });

  it("CMM-N11-SPLIT-2: notes mode does NOT feed query into useSearch (always called with '')", () => {
    // Plan 07-40 (UAT-6): useSearch is now hosted inside CommandMenu so the
    // hook is called every render, but mode='notes' passes the empty string
    // so the hook stays dormant (no debounce, no fetch). The original spirit
    // — "notes mode never triggers FTS5 fetches" — is preserved by gating
    // on the empty query, not by skipping the hook entirely.
    mockUseQuickSwitcher.mockReturnValue([TITLE_HIT]);
    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "al" } });
    // Every call passes the empty string as the query — useSearch never sees
    // the user's actual notes-mode query.
    for (const call of mockUseSearch.mock.calls) {
      expect(call[0]).toBe("");
    }
  });

  it("CMM-N11-SPLIT-3: a body-only match (no title fuzzy hit) shows nothing in switcher", () => {
    // Title-fuzzy returns no hits (the query matches body, not title).
    mockUseQuickSwitcher.mockReturnValue([]);
    // Even though useSearch would have FTS5 hits, the switcher ignores them.
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "al" } });

    // No search-result rows.
    const searchRow = document.querySelector('[data-row-kind="search-result"]');
    expect(searchRow).toBeNull();
    // Empty state should appear.
    expect(screen.getByText(/No notes match "al"/)).toBeTruthy();
  });

  it("CMM-N11-SPLIT-4: a title-only match shows ONLY title rows; no second section", () => {
    mockUseQuickSwitcher.mockReturnValue([TITLE_HIT]);
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "al" } });

    // Title row visible.
    expect(screen.getByText("alpha")).toBeTruthy();
    // No 'Search results' eyebrow / no search-result row anywhere.
    expect(
      document.querySelector('[data-row-kind="group"][data-group-id="group:search"]'),
    ).toBeNull();
    expect(document.querySelector('[data-row-kind="search-result"]')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// CMM-SEARCH-MODE — Plan 07-40 (UAT-6) — CommandMenu mode='search'
//
// Search now lives in CommandMenu as a third mode (alongside 'notes' and
// 'commands'). Invoked by Cmd+Shift+F (App.tsx). Renders an FTS5 input,
// empty-state when <2 chars, and SearchResultRow rows for each useSearch hit.
// ──────────────────────────────────────────────────────────────────────────────

describe("CMM-SEARCH-MODE — Plan 07-40 (UAT-6) — CommandMenu mode='search'", () => {
  const defaultSearchProps = {
    open: true,
    onOpenChange: vi.fn(),
    mode: "search" as const,
    actions: {},
  };

  const FTS5_HIT = {
    id: "n-search-1",
    title: "Hello World",
    path: "notes/hello.md",
    excerpt_html: "this is a <mark>hello</mark> excerpt",
    matching_tags: [],
    rank: 1,
    modified_at: "2026-05-16T00:00:00Z",
  };

  it("CMM-SEARCH-MODE-1: mode='search' renders input with 'Search notes…' placeholder", () => {
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    expect(screen.getByPlaceholderText("Search notes…")).toBeTruthy();
  });

  it("CMM-SEARCH-MODE-2: typing < 2 chars renders an empty-state hint", () => {
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = screen.getByRole("textbox");
    // 1 character — below the search threshold
    fireEvent.change(input, { target: { value: "a" } });
    expect(
      screen.getByText(/Type at least 2 characters/),
    ).toBeTruthy();
  });

  it("CMM-SEARCH-MODE-3: typing >= 2 chars triggers useSearch and renders SearchResultRow rows", () => {
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "he" } });
    // SearchResultRow renders title text "Hello World".
    expect(screen.getByText("Hello World")).toBeTruthy();
    // useSearch must have been called (it is the data source for mode='search').
    expect(mockUseSearch).toHaveBeenCalled();
  });

  it("CMM-SEARCH-MODE-4: SearchResultRow shows the snippet excerpt with <mark>", () => {
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "he" } });
    // The <mark> survives sanitization (Plan 07 ADD_TAGS: ["mark"]).
    const mark = document.querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe("hello");
  });

  it("CMM-SEARCH-MODE-5: selecting a result calls setActiveNote(result.id) + closes the modal", () => {
    const onOpenChange = vi.fn();
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "he" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockSetActiveNote).toHaveBeenCalledWith(FTS5_HIT.id);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("CMM-SEARCH-MODE-6: mode='search' does NOT render the commands list nor the title-fuzzy switcher", () => {
    // Seed both fuzzysort + command palette with hits to prove they're ignored.
    mockUseQuickSwitcher.mockReturnValue([
      { id: "fuzzy-1", title: "Fuzzy Hit", path: "fuzz.md" },
    ]);
    const cmds = [
      { id: "new-note", label: "New note", group: "File", inPalette: true, inCheatSheet: true },
    ];
    const mockFiltered = vi.fn().mockReturnValue(cmds);
    mockUseCommandPalette.mockReturnValue({
      filtered: mockFiltered,
      execute: vi.fn().mockReturnValue(true),
    });
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });

    render(<CommandMenu {...defaultSearchProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "he" } });

    // Search results visible.
    expect(screen.getByText("Hello World")).toBeTruthy();
    // Fuzzy title hit must NOT be rendered.
    expect(screen.queryByText("Fuzzy Hit")).toBeNull();
    // Commands list must NOT be rendered.
    expect(screen.queryByText("New note")).toBeNull();
  });
});
