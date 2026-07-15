/**
 * CommandMenu tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";


vi.mock("../lib/useFileTree", () => ({
  useFileTree: vi.fn(),
}));

vi.mock("../lib/useTreeStore", () => ({
  useTreeStore: vi.fn(),
}));

vi.mock("../lib/useTabStore", () => ({
  useTabStore: {
    getState: vi.fn(),
  },
}));

vi.mock("../lib/useQuickSwitcher", () => ({
  useQuickSwitcher: vi.fn(),
}));

vi.mock("../lib/useCommandPalette", () => ({
  useCommandPalette: vi.fn(),
}));


vi.mock("../lib/useSearch", () => ({
  useSearch: vi.fn(),
}));

vi.mock("fuzzysort", () => ({
  default: {
    single: vi.fn(),
    go: vi.fn(),
  },
}));


const mockMeasureElement = vi.fn();
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
    measureElement: mockMeasureElement,
    measure: vi.fn(),
  })),
}));

import { CommandMenu } from "./CommandMenu";
import { useFileTree } from "../lib/useFileTree";
import { useTreeStore } from "../lib/useTreeStore";
import { useTabStore } from "../lib/useTabStore";
import { useQuickSwitcher } from "../lib/useQuickSwitcher";
import { useCommandPalette } from "../lib/useCommandPalette";
import { useSearch } from "../lib/useSearch";
import { useVirtualizer } from "@tanstack/react-virtual";
import fuzzysort from "fuzzysort";

const mockUseFileTree = useFileTree as unknown as ReturnType<typeof vi.fn>;
const mockUseTreeStore = useTreeStore as unknown as ReturnType<typeof vi.fn>;
const mockUseTabStoreGetState = useTabStore.getState as unknown as ReturnType<typeof vi.fn>;
const mockUseQuickSwitcher = useQuickSwitcher as unknown as ReturnType<typeof vi.fn>;
const mockUseCommandPalette = useCommandPalette as unknown as ReturnType<typeof vi.fn>;
const mockUseSearch = useSearch as unknown as ReturnType<typeof vi.fn>;
const mockUseVirtualizer = useVirtualizer as unknown as ReturnType<typeof vi.fn>;
const mockFuzzysortSingle = fuzzysort.single as unknown as ReturnType<typeof vi.fn>;


const mockSetActiveNote = vi.fn();
const mockRecordOpenedNote = vi.fn();
const mockOpenTab = vi.fn();

function setupMocks() {
  mockUseFileTree.mockReturnValue({ tree: null, loading: false, error: null });

  mockUseTreeStore.mockImplementation((selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setActiveNote: mockSetActiveNote,
      recordOpenedNote: mockRecordOpenedNote,
      recentlyOpenedNoteIds: [],
      activeTagFilter: null,
      setSearchActive: vi.fn(),
      setSearchQuery: vi.fn(),
      setSearchResults: vi.fn(),
    };
    return selector(state);
  });

  mockUseTabStoreGetState.mockReturnValue({ openTab: mockOpenTab });

  mockUseQuickSwitcher.mockReturnValue([]);
  mockUseCommandPalette.mockReturnValue({
    filtered: vi.fn().mockReturnValue([]),
    execute: vi.fn().mockReturnValue(true),
    isDisabled: vi.fn().mockReturnValue(false),
  });
  mockUseSearch.mockReturnValue({ results: [], isSearching: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupMocks();
});


const defaultNoteProps = {
  open: true,
  onOpenChange: vi.fn(),
  mode: "notes" as const,
  actions: {},
};


const defaultCmdProps = {
  open: true,
  onOpenChange: vi.fn(),
  mode: "commands" as const,
  actions: {},
};

describe("CommandMenu — open/close", () => {
  it("renders dialog content when open=true", () => {
    render(<CommandMenu {...defaultNoteProps} />);
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("does not render dialog content when open=false", () => {
    render(<CommandMenu {...defaultNoteProps} open={false} />);
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
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOpenTab).toHaveBeenCalledWith("n2");
  });

  it("ArrowUp does not go below index 0", async () => {
    const notes = [{ id: "n1", title: "Only Note", path: "only.md" }];
    mockUseQuickSwitcher.mockReturnValue(notes);
    render(<CommandMenu {...defaultNoteProps} />);

    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOpenTab).toHaveBeenCalledWith("n1");
  });

  it("Enter activates selected note: calls openTab + recordOpenedNote + onOpenChange(false)", () => {
    const onOpenChange = vi.fn();
    const notes = [{ id: "n1", title: "Meeting Notes", path: "meeting.md" }];
    mockUseQuickSwitcher.mockReturnValue(notes);

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockOpenTab).toHaveBeenCalledWith("n1");
    expect(mockSetActiveNote).not.toHaveBeenCalled();
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

describe("CommandMenu — XSS safety", () => {
  it("renders query text in empty state copy without XSS (React escapes by default)", () => {
    const mockFiltered = vi.fn().mockReturnValue([]);
    mockUseCommandPalette.mockReturnValue({ filtered: mockFiltered, execute: vi.fn() });

    render(<CommandMenu {...defaultCmdProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: '<script>alert("xss")</script>' } });

    const emptyState = screen.getByText(/No commands match/);
    expect(emptyState).toBeTruthy();
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

    rerender(<CommandMenu {...defaultCmdProps} open={false} />);
    rerender(<CommandMenu {...defaultCmdProps} open={true} />);
    const newInput = screen.getByRole("textbox");
    expect((newInput as HTMLInputElement).value).toBe("");
  });
});

describe("CommandMenu — closeOnExecute behavior", () => {
  it("Switch note command does NOT call onOpenChange(false) when execute returns false", () => {
    const onOpenChange = vi.fn();
    const mockExecute = vi.fn().mockReturnValue(false);
    const cmds = [
      { id: "switch-note", label: "Switch / search notes", group: "Navigation", inPalette: true, inCheatSheet: true },
    ];
    const mockFiltered = vi.fn().mockReturnValue(cmds);
    mockUseCommandPalette.mockReturnValue({ filtered: mockFiltered, execute: mockExecute });

    render(<CommandMenu {...defaultCmdProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockExecute).toHaveBeenCalledWith("switch-note");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("New note command DOES call onOpenChange(false) when execute returns true", () => {
    const onOpenChange = vi.fn();
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

    expect(mockOpenTab).toHaveBeenCalledWith("n1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});


describe("CMM-mode-reset — query clears on mode change while open", () => {
  it("resets local query to empty string when paletteMode flips while open", async () => {
    const mockFiltered = vi.fn().mockReturnValue([]);
    mockUseCommandPalette.mockReturnValue({ filtered: mockFiltered, execute: vi.fn() });

    const { rerender } = render(
      <CommandMenu open={true} onOpenChange={vi.fn()} mode="commands" actions={{}} />
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "fi" } });
    expect((input as HTMLInputElement).value).toBe("fi");

    rerender(
      <CommandMenu open={true} onOpenChange={vi.fn()} mode="notes" actions={{}} />
    );

    const updatedInput = screen.getByRole("textbox");
    expect((updatedInput as HTMLInputElement).value).toBe("");
  });
});


describe("CMM-NAV — single-section navigation", () => {
  const MOCK_TITLE_HIT = { id: "n1", title: "test", path: "test.md" };

  it("CMM-NAV-2: ArrowUp at first selectable does not advance into a non-existent row above", () => {
    mockUseQuickSwitcher.mockReturnValue([MOCK_TITLE_HIT]);

    render(<CommandMenu {...defaultNoteProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "te" } });

    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOpenTab).toHaveBeenCalledWith("n1");
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

describe("CMM-INIT — selectedIdx starts at first selectable", () => {
  it("CMM-INIT-1: pressing Enter immediately without ArrowDown activates the first note row", () => {
    const MOCK_TITLE_HIT = { id: "n1", title: "test", path: "test.md" };
    mockUseQuickSwitcher.mockReturnValue([MOCK_TITLE_HIT]);
    const onOpenChange = vi.fn();

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "te" } });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOpenTab).toHaveBeenCalledWith("n1");
  });
});


describe("CMM-N11-SPLIT — switcher is title-fuzzy only", () => {
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
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "al" } });

    const searchEyebrow = document.querySelector(
      '[data-row-kind="group"][data-group-id="group:search"]',
    );
    expect(searchEyebrow).toBeNull();
    expect(screen.queryByText("Search results")).toBeNull();
  });

  it("CMM-N11-SPLIT-2: notes mode does NOT feed query into useSearch (always called with '')", () => {
    mockUseQuickSwitcher.mockReturnValue([TITLE_HIT]);
    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "al" } });
    for (const call of mockUseSearch.mock.calls) {
      expect(call[0]).toBe("");
    }
  });

  it("CMM-N11-SPLIT-3: a body-only match (no title fuzzy hit) shows nothing in switcher", () => {
    mockUseQuickSwitcher.mockReturnValue([]);
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "al" } });

    const searchRow = document.querySelector('[data-row-kind="search-result"]');
    expect(searchRow).toBeNull();
    expect(screen.getByText(/No notes match "al"/)).toBeTruthy();
  });

  it("CMM-N11-SPLIT-4: a title-only match shows ONLY title rows; no second section", () => {
    mockUseQuickSwitcher.mockReturnValue([TITLE_HIT]);
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "al" } });

    expect(screen.getByText("alpha")).toBeTruthy();
    expect(
      document.querySelector('[data-row-kind="group"][data-group-id="group:search"]'),
    ).toBeNull();
    expect(document.querySelector('[data-row-kind="search-result"]')).toBeNull();
  });
});


describe("CMM-SEARCH-MODE — CommandMenu mode='search'", () => {
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

  it("CMM-SEARCH-MODE-2: typing < 2 chars renders an indicator or empty hint (post UAT-8)", () => {
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "a" } });
    expect(screen.queryByText(/at least 2 characters/i)).toBeNull();
    expect(screen.getByText("Searching…")).toBeTruthy();
  });

  it("CMM-SEARCH-MODE-3: typing >= 2 chars triggers useSearch and renders SearchResultRow rows", () => {
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "he" } });
    expect(screen.getByText("Hello World")).toBeTruthy();
    expect(mockUseSearch).toHaveBeenCalled();
  });

  it("CMM-SEARCH-MODE-4: SearchResultRow shows the snippet excerpt with <mark>", () => {
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "he" } });
    const mark = document.querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe("hello");
  });

  it("CMM-SEARCH-MODE-5: selecting a result calls openTab(result.id) + closes the modal", () => {
    const onOpenChange = vi.fn();
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} onOpenChange={onOpenChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "he" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOpenTab).toHaveBeenCalledWith(FTS5_HIT.id);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("CMM-SEARCH-MODE-6: mode='search' does NOT render the commands list nor the title-fuzzy switcher", () => {
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

    expect(screen.getByText("Hello World")).toBeTruthy();
    expect(screen.queryByText("Fuzzy Hit")).toBeNull();
    expect(screen.queryByText("New note")).toBeNull();
  });
});


describe("CMM-UAT7-MEASURE — virtualizer measures search-result rows", () => {
  const defaultSearchProps = {
    open: true,
    onOpenChange: vi.fn(),
    mode: "search" as const,
    actions: {},
  };

  const FTS5_HIT = {
    id: "n-measure-1",
    title: "Measured Note",
    path: "notes/measured.md",
    excerpt_html: "an excerpt with <mark>match</mark>",
    matching_tags: ["tagA", "tagB"],
    rank: 1,
    modified_at: "2026-05-16T00:00:00Z",
  };

  it("CMM-UAT7-MEASURE-1: search-result row container has a ref AND a data-index attribute", () => {
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ma" } });

    const row = document.querySelector('[data-row-kind="search-result"]') as HTMLElement | null;
    expect(row).not.toBeNull();
    expect(row?.getAttribute("data-index")).toBe("0");
  });

  it("CMM-UAT7-MEASURE-2: useVirtualizer is called with a measureElement option (function)", () => {
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ma" } });

    const calls = mockUseVirtualizer.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const anyCallHasMeasure = calls.some(
      ([opts]) => typeof opts?.measureElement === "function",
    );
    expect(anyCallHasMeasure).toBe(true);
  });
});


describe("CMM-UAT8FU — measureElement gated on search-result rows only", () => {
  const NOTE_HIT = { id: "n-fu-1", title: "Plain Note", path: "plain.md" };
  const CMD_ITEM = {
    id: "new-note",
    label: "New note",
    group: "File",
    shortcut: "⌘N",
    inPalette: true,
    inCheatSheet: true,
  };
  const FTS5_HIT = {
    id: "n-fu-search-1",
    title: "Search Hit",
    path: "search.md",
    excerpt_html: "an excerpt with <mark>match</mark>",
    matching_tags: [],
    rank: 1,
    modified_at: "2026-05-17T00:00:00Z",
  };

  it("CMM-UAT8FU-1: in mode='commands', cmd rows do NOT have data-index (no measureElement attached)", () => {
    const mockFiltered = vi.fn().mockReturnValue([CMD_ITEM]);
    mockUseCommandPalette.mockReturnValue({ filtered: mockFiltered, execute: vi.fn() });

    render(<CommandMenu {...defaultCmdProps} />);

    expect(screen.getByText("New note")).toBeTruthy();

    const cmdRow = document.querySelector('[data-row-kind="cmd"]') as HTMLElement | null;
    expect(cmdRow).not.toBeNull();
    expect(cmdRow?.hasAttribute("data-index")).toBe(false);
  });

  it("CMM-UAT8FU-2: in mode='notes', note rows do NOT have data-index (no measureElement attached)", () => {
    mockUseQuickSwitcher.mockReturnValue([NOTE_HIT]);

    render(<CommandMenu {...defaultNoteProps} />);

    expect(screen.getByText("Plain Note")).toBeTruthy();

    const noteRow = document.querySelector('[data-row-kind="note"]') as HTMLElement | null;
    expect(noteRow).not.toBeNull();
    expect(noteRow?.hasAttribute("data-index")).toBe(false);
  });

  it("CMM-UAT8FU-3: in mode='search', search-result rows DO have data-index (measureElement preserved from Plan 07-42)", () => {
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });

    render(<CommandMenu open={true} onOpenChange={vi.fn()} mode="search" actions={{}} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ma" } });

    const row = document.querySelector('[data-row-kind="search-result"]') as HTMLElement | null;
    expect(row).not.toBeNull();
    expect(row?.getAttribute("data-index")).toBe("0");
  });

  it("CMM-UAT8FU-4: switching mode from 'search' to 'notes' calls virtualizer.measure() to flush cached row heights", () => {
    const measureSpy = vi.fn();
    mockUseVirtualizer.mockImplementation(({ count }: { count: number }) => ({
      getVirtualItems: () =>
        Array.from({ length: count }, (_, i) => ({
          index: i,
          start: i * 36,
          size: 36,
          key: i,
        })),
      getTotalSize: () => count * 36,
      scrollToIndex: vi.fn(),
      measureElement: vi.fn(),
      measure: measureSpy,
    }));

    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });
    mockUseQuickSwitcher.mockReturnValue([NOTE_HIT]);

    const { rerender } = render(
      <CommandMenu open={true} onOpenChange={vi.fn()} mode="search" actions={{}} />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ma" } });

    measureSpy.mockClear();

    rerender(
      <CommandMenu open={true} onOpenChange={vi.fn()} mode="notes" actions={{}} />,
    );

    expect(measureSpy).toHaveBeenCalled();
  });
});

describe("CMM-UAT8 — activity indicator + empty-state copy", () => {
  const defaultSearchProps = {
    open: true,
    onOpenChange: vi.fn(),
    mode: "search" as const,
    actions: {},
  };

  const FTS5_HIT = {
    id: "n-uat8-1",
    title: "Hello World",
    path: "notes/hello.md",
    excerpt_html: "this is a <mark>hello</mark> excerpt",
    matching_tags: [],
    rank: 1,
    modified_at: "2026-05-17T00:00:00Z",
  };

  it("CMM-UAT8-1: empty query renders 'Type to search notes' (no 'at least 2 characters' copy anywhere)", () => {
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    expect(screen.getByText("Type to search notes")).toBeTruthy();
    expect(screen.queryByText(/at least 2 characters/i)).toBeNull();
  });

  it("CMM-UAT8-2: 1-char query renders the activity indicator (Loader2 + 'Searching…')", () => {
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "t" } });
    expect(screen.getByText("Searching…")).toBeTruthy();
    const indicator = screen.getByText("Searching…").closest("div");
    expect(indicator?.querySelector("svg")).not.toBeNull();
  });

  it("CMM-UAT8-3: query >= 2 chars AND isSearching=true renders the activity indicator", () => {
    mockUseSearch.mockReturnValue({ results: [], isSearching: true });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "test" } });
    expect(screen.getByText("Searching…")).toBeTruthy();
    expect(screen.queryByText(/No notes match/i)).toBeNull();
  });

  it("CMM-UAT8-4: query >= 2 chars AND isSearching=false AND results=[] renders existing 'No notes match' state", () => {
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "zz" } });
    expect(screen.getByText(/No notes match "zz"/)).toBeTruthy();
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("CMM-UAT8-5: query >= 2 chars AND isSearching=false AND results.length>0 renders results (no indicator, no empty state)", () => {
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "he" } });
    expect(screen.getByText("Hello World")).toBeTruthy();
    expect(screen.queryByText("Searching…")).toBeNull();
    expect(screen.queryByText(/No notes match/i)).toBeNull();
    expect(screen.queryByText("Type to search notes")).toBeNull();
  });
});


describe("CMM-UAT8FU2 — input-row activity indicator + stale-state preservation", () => {
  const defaultSearchProps = {
    open: true,
    onOpenChange: vi.fn(),
    mode: "search" as const,
    actions: {},
  };

  const FTS5_HIT = {
    id: "n-uat8fu2-1",
    title: "Stale Hit",
    path: "notes/stale.md",
    excerpt_html: "this is a <mark>stale</mark> excerpt",
    matching_tags: [],
    rank: 1,
    modified_at: "2026-05-17T00:00:00Z",
  };

  it("CMM-UAT8FU2-1: mode='search' + isSearching=true renders a Loader2 spinner with aria-label 'Searching' inside the input row", () => {
    mockUseSearch.mockReturnValue({ results: [], isSearching: true });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "te" } });

    const inputRow = input.parentElement;
    expect(inputRow).not.toBeNull();
    const spinner = inputRow?.querySelector('[aria-label="Searching"]');
    expect(spinner).not.toBeNull();
    expect(spinner?.tagName.toLowerCase()).toBe("svg");
  });

  it("CMM-UAT8FU2-2: mode='search' + isSearching=false renders NO spinner in the input row", () => {
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "te" } });

    const inputRow = input.parentElement;
    expect(inputRow).not.toBeNull();
    const spinner = inputRow?.querySelector('[aria-label="Searching"]');
    expect(spinner).toBeNull();
  });

  it("CMM-UAT8FU2-3: mode='commands' + isSearching=true (defensive) renders NO spinner in the input row", () => {
    mockUseSearch.mockReturnValue({ results: [], isSearching: true });
    mockUseCommandPalette.mockReturnValue({
      filtered: vi.fn().mockReturnValue([]),
      execute: vi.fn().mockReturnValue(true),
    });

    render(<CommandMenu {...defaultCmdProps} />);
    const input = screen.getByRole("textbox");

    const inputRow = input.parentElement;
    expect(inputRow).not.toBeNull();
    const spinner = inputRow?.querySelector('[aria-label="Searching"]');
    expect(spinner).toBeNull();
  });

  it("CMM-UAT8FU2-4: mode='search' + isSearching=true + results.length>0 keeps the prior result list rendered (stale-state preserved)", () => {
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: true });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "st" } });

    expect(screen.getByText("Stale Hit")).toBeTruthy();
    expect(screen.queryByText("Searching…")).toBeNull();
    const inputRow = input.parentElement;
    const spinner = inputRow?.querySelector('[aria-label="Searching"]');
    expect(spinner).not.toBeNull();
  });

  it("CMM-UAT8FU2-5: mode='search' + isSearching=true + results.length===0 (first-search fallback) renders the result-area ActivityIndicator", () => {
    mockUseSearch.mockReturnValue({ results: [], isSearching: true });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "zz" } });

    expect(screen.getByText("Searching…")).toBeTruthy();
  });
});


describe("CommandMenu — mode='all' unified list (PALETTE-01/02)", () => {
  const defaultAllProps = { open: true, onOpenChange: vi.fn(), mode: "all" as const, actions: {} };

  it("CMM-ALL-1: empty query renders note rows (recents) with no group-header rows", () => {
    mockUseQuickSwitcher.mockReturnValue([
      { id: "n1", title: "Recent Note", path: "recent.md" },
    ]);
    mockUseCommandPalette.mockReturnValue({
      filtered: vi.fn().mockReturnValue([]),
      execute: vi.fn(),
      isDisabled: vi.fn().mockReturnValue(false),
    });

    render(<CommandMenu {...defaultAllProps} />);
    expect(screen.getByText("Recent Note")).toBeTruthy();
    expect(document.querySelector('[data-row-kind="group"]')).toBeNull();
  });

  it("CMM-ALL-2: matching query renders both a note and a command, kind-badged, no section headers, ordered by score", () => {
    mockUseQuickSwitcher.mockReturnValue([
      { id: "n1", title: "Best Match Note", path: "best.md", score: -1 },
    ]);
    mockFuzzysortSingle.mockReturnValue({ score: -9999 });
    mockUseCommandPalette.mockReturnValue({
      filtered: vi.fn().mockReturnValue([
        { id: "today", label: "Today", group: "Navigation", shortcut: "⌘⇧D", inPalette: true, inCheatSheet: true },
      ]),
      execute: vi.fn(),
      isDisabled: vi.fn().mockReturnValue(false),
    });

    render(<CommandMenu {...defaultAllProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "match" } });

    expect(screen.getByText("Best Match Note")).toBeTruthy();
    expect(screen.getByText("Today")).toBeTruthy();
    expect(document.querySelector('[data-row-kind="group"]')).toBeNull();

    const rows = Array.from(document.querySelectorAll("[data-row-kind]"));
    const kinds = rows.map((r) => r.getAttribute("data-row-kind"));
    expect(kinds.indexOf("note")).toBeLessThan(kinds.indexOf("cmd"));
  });

  it("CMM-ALL-3: zero-match query renders 'No matching notes or commands for \"{query}\"' copy", () => {
    mockUseQuickSwitcher.mockReturnValue([]);
    mockUseCommandPalette.mockReturnValue({
      filtered: vi.fn().mockReturnValue([]),
      execute: vi.fn(),
      isDisabled: vi.fn().mockReturnValue(false),
    });

    render(<CommandMenu {...defaultAllProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "zzz" } });
    expect(screen.getByText('No matching notes or commands for "zzz"')).toBeTruthy();
  });

  it("CMM-ALL-4: aria-label and placeholder are unified-mode specific", () => {
    mockUseQuickSwitcher.mockReturnValue([]);
    mockUseCommandPalette.mockReturnValue({
      filtered: vi.fn().mockReturnValue([]),
      execute: vi.fn(),
      isDisabled: vi.fn().mockReturnValue(false),
    });

    render(<CommandMenu {...defaultAllProps} />);
    expect(screen.getByPlaceholderText("Search notes and commands…")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Search everything" })).toBeTruthy();
  });
});


describe("CommandMenu — regression: scoped modes unaffected by unified mode addition", () => {
  it("mode='notes' still shows only note rows for a matching query (no cmd rows)", () => {
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Only Note", path: "only.md" }]);
    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "on" } });
    expect(screen.getByText("Only Note")).toBeTruthy();
    expect(document.querySelector('[data-row-kind="cmd"]')).toBeNull();
  });

  it("mode='commands' still shows only cmd rows for a matching query (no note rows)", () => {
    const cmds = [
      { id: "new-note", label: "New note", group: "File", inPalette: true, inCheatSheet: true },
    ];
    mockUseCommandPalette.mockReturnValue({
      filtered: vi.fn().mockReturnValue(cmds),
      execute: vi.fn(),
      isDisabled: vi.fn().mockReturnValue(false),
    });
    render(<CommandMenu {...defaultCmdProps} />);
    expect(screen.getByText("New note")).toBeTruthy();
    expect(document.querySelector('[data-row-kind="note"]')).toBeNull();
  });
});


describe("CommandMenu — kind badges (D-01 restyle)", () => {
  it("note rows carry a 'Note' kind badge", () => {
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Meeting Notes", path: "meeting.md" }]);
    render(<CommandMenu {...defaultNoteProps} />);
    expect(screen.getByText("Note")).toBeTruthy();
  });

  it("command rows carry a 'Cmd' kind badge", () => {
    const cmds = [
      { id: "new-note", label: "New note", group: "File", inPalette: true, inCheatSheet: true },
    ];
    mockUseCommandPalette.mockReturnValue({
      filtered: vi.fn().mockReturnValue(cmds),
      execute: vi.fn(),
      isDisabled: vi.fn().mockReturnValue(false),
    });
    render(<CommandMenu {...defaultCmdProps} />);
    expect(screen.getByText("Cmd")).toBeTruthy();
  });
});
