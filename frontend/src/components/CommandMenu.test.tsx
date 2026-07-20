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

vi.mock("../lib/usePaneStore", () => ({
  usePaneStore: {
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

vi.mock("../lib/useTreeMutations", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/useTreeMutations")
  >("../lib/useTreeMutations");
  return {
    ...actual,
    useTreeMutations: vi.fn(),
  };
});

vi.mock("./toast.utils", () => ({
  useToast: vi.fn(),
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
import { usePaneStore } from "../lib/usePaneStore";
import { useQuickSwitcher } from "../lib/useQuickSwitcher";
import { useCommandPalette } from "../lib/useCommandPalette";
import { useSearch } from "../lib/useSearch";
import { useTreeMutations } from "../lib/useTreeMutations";
import { useToast } from "./toast.utils";
import { useVirtualizer } from "@tanstack/react-virtual";

const mockUseFileTree = useFileTree as unknown as ReturnType<typeof vi.fn>;
const mockUseTreeStore = useTreeStore as unknown as ReturnType<typeof vi.fn>;
const mockUsePaneStoreGetState = usePaneStore.getState as unknown as ReturnType<typeof vi.fn>;
const mockUseQuickSwitcher = useQuickSwitcher as unknown as ReturnType<typeof vi.fn>;
const mockUseCommandPalette = useCommandPalette as unknown as ReturnType<typeof vi.fn>;
const mockUseSearch = useSearch as unknown as ReturnType<typeof vi.fn>;
const mockUseTreeMutations = useTreeMutations as unknown as ReturnType<typeof vi.fn>;
const mockUseToast = useToast as unknown as ReturnType<typeof vi.fn>;
const mockUseVirtualizer = useVirtualizer as unknown as ReturnType<typeof vi.fn>;


const mockSetActiveNote = vi.fn();
const mockRecordOpenedNote = vi.fn();
const mockOpenInActivePane = vi.fn();
const mockOpenNoteInNewSplit = vi.fn();
const mockCreateNote = vi.fn();
const mockToast = vi.fn();

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
      activeNoteId: null,
    };
    return selector(state);
  });

  mockUsePaneStoreGetState.mockReturnValue({
    openInActivePane: mockOpenInActivePane,
    openNoteInNewSplit: mockOpenNoteInNewSplit,
  });

  mockUseQuickSwitcher.mockReturnValue([]);
  mockUseCommandPalette.mockReturnValue({
    filtered: vi.fn().mockReturnValue([]),
    execute: vi.fn().mockReturnValue(true),
    isDisabled: vi.fn().mockReturnValue(false),
  });
  mockUseSearch.mockReturnValue({ results: [], isSearching: false });

  mockUseTreeMutations.mockReturnValue({
    createNote: mockCreateNote,
    deleteNote: vi.fn(),
    moveNote: vi.fn(),
    createFolder: vi.fn(),
    deleteFolder: vi.fn(),
    moveFolder: vi.fn(),
    moveFile: vi.fn(),
  });
  mockUseToast.mockReturnValue({ toast: mockToast });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupMocks();
});

/**
 * The palette input is role="textbox" in commands/search mode but
 * role="combobox" in notes mode (D-13/D-16 ARIA wiring, 28-04). Tests that
 * don't care which mode is under test query via this helper instead of a
 * hardcoded role.
 */
function getPaletteInput(): HTMLElement {
  return (screen.queryByRole("textbox") ?? screen.getByRole("combobox")) as HTMLElement;
}


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
    expect(getPaletteInput()).toBeTruthy();
  });

  it("does not render dialog content when open=false", () => {
    render(<CommandMenu {...defaultNoteProps} open={false} />);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("CommandMenu — mode prop (notes)", () => {
  it("shows 'Find or create a note…' placeholder in notes mode", () => {
    render(<CommandMenu {...defaultNoteProps} />);
    expect(screen.getByPlaceholderText("Find or create a note…")).toBeTruthy();
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
    const input = getPaletteInput();
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

    const input = getPaletteInput();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOpenInActivePane).toHaveBeenCalledWith("n2");
  });

  it("ArrowUp does not go below index 0", async () => {
    const notes = [{ id: "n1", title: "Only Note", path: "only.md" }];
    mockUseQuickSwitcher.mockReturnValue(notes);
    render(<CommandMenu {...defaultNoteProps} />);

    const input = getPaletteInput();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOpenInActivePane).toHaveBeenCalledWith("n1");
  });

  it("Enter activates selected note: calls openTab + recordOpenedNote + onOpenChange(false)", () => {
    const onOpenChange = vi.fn();
    const notes = [{ id: "n1", title: "Meeting Notes", path: "meeting.md" }];
    mockUseQuickSwitcher.mockReturnValue(notes);

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    const input = getPaletteInput();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockOpenInActivePane).toHaveBeenCalledWith("n1");
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
    const input = getPaletteInput();
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
    const input = getPaletteInput();
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
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: "hello" } });
    expect((input as HTMLInputElement).value).toBe("hello");

    rerender(<CommandMenu {...defaultCmdProps} open={false} />);
    rerender(<CommandMenu {...defaultCmdProps} open={true} />);
    const newInput = getPaletteInput();
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
    const input = getPaletteInput();
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
    const input = getPaletteInput();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockExecute).toHaveBeenCalledWith("new-note");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Note selection always calls onOpenChange(false) regardless of closeOnExecute", () => {
    const onOpenChange = vi.fn();
    const notes = [{ id: "n1", title: "My Note", path: "my-note.md" }];
    mockUseQuickSwitcher.mockReturnValue(notes);

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    const input = getPaletteInput();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockOpenInActivePane).toHaveBeenCalledWith("n1");
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

    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: "fi" } });
    expect((input as HTMLInputElement).value).toBe("fi");

    rerender(
      <CommandMenu open={true} onOpenChange={vi.fn()} mode="notes" actions={{}} />
    );

    const updatedInput = getPaletteInput();
    expect((updatedInput as HTMLInputElement).value).toBe("");
  });
});


describe("CMM-NAV — single-section navigation", () => {
  const MOCK_TITLE_HIT = { id: "n1", title: "test", path: "test.md" };

  it("CMM-NAV-2: ArrowUp at first selectable does not advance into a non-existent row above", () => {
    mockUseQuickSwitcher.mockReturnValue([MOCK_TITLE_HIT]);

    render(<CommandMenu {...defaultNoteProps} />);
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: "te" } });

    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOpenInActivePane).toHaveBeenCalledWith("n1");
  });

  it("CMM-NAV-3: Enter when items is empty is a no-op (defensive)", () => {
    mockUseQuickSwitcher.mockReturnValue([]);
    const onOpenChange = vi.fn();

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    const input = getPaletteInput();
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
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: "te" } });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOpenInActivePane).toHaveBeenCalledWith("n1");
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
    fireEvent.change(getPaletteInput(), { target: { value: "al" } });

    const searchEyebrow = document.querySelector(
      '[data-row-kind="group"][data-group-id="group:search"]',
    );
    expect(searchEyebrow).toBeNull();
    expect(screen.queryByText("Search results")).toBeNull();
  });

  it("CMM-N11-SPLIT-2: notes mode does NOT feed query into useSearch (always called with '')", () => {
    mockUseQuickSwitcher.mockReturnValue([TITLE_HIT]);
    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "al" } });
    for (const call of mockUseSearch.mock.calls) {
      expect(call[0]).toBe("");
    }
  });

  it("CMM-N11-SPLIT-3: a body-only match (no title fuzzy hit) shows the create row, not a search result (28-05: create row replaces the old 'no matches' empty state per UI-SPEC)", () => {
    mockUseQuickSwitcher.mockReturnValue([]);
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "al" } });

    const searchRow = document.querySelector('[data-row-kind="search-result"]');
    expect(searchRow).toBeNull();
    expect(screen.getByText('Create "al"')).toBeTruthy();
  });

  it("CMM-N11-SPLIT-4: a title-only match shows ONLY title rows; no second section", () => {
    mockUseQuickSwitcher.mockReturnValue([TITLE_HIT]);
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });

    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "al" } });

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
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: "a" } });
    expect(screen.queryByText(/at least 2 characters/i)).toBeNull();
    expect(screen.getByText("Searching…")).toBeTruthy();
  });

  it("CMM-SEARCH-MODE-3: typing >= 2 chars triggers useSearch and renders SearchResultRow rows", () => {
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: "he" } });
    expect(screen.getByText("Hello World")).toBeTruthy();
    expect(mockUseSearch).toHaveBeenCalled();
  });

  it("CMM-SEARCH-MODE-4: SearchResultRow shows the snippet excerpt with <mark>", () => {
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "he" } });
    const mark = document.querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe("hello");
  });

  it("CMM-SEARCH-MODE-5: selecting a result calls openTab(result.id) + closes the modal", () => {
    const onOpenChange = vi.fn();
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} onOpenChange={onOpenChange} />);
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: "he" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOpenInActivePane).toHaveBeenCalledWith(FTS5_HIT.id);
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
    fireEvent.change(getPaletteInput(), { target: { value: "he" } });

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
    fireEvent.change(getPaletteInput(), { target: { value: "ma" } });

    const row = document.querySelector('[data-row-kind="search-result"]') as HTMLElement | null;
    expect(row).not.toBeNull();
    expect(row?.getAttribute("data-index")).toBe("0");
  });

  it("CMM-UAT7-MEASURE-2: useVirtualizer is called with a measureElement option (function)", () => {
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "ma" } });

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
    fireEvent.change(getPaletteInput(), { target: { value: "ma" } });

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
    fireEvent.change(getPaletteInput(), { target: { value: "ma" } });

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
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: "t" } });
    expect(screen.getByText("Searching…")).toBeTruthy();
    const indicator = screen.getByText("Searching…").closest("div");
    expect(indicator?.querySelector("svg")).not.toBeNull();
  });

  it("CMM-UAT8-3: query >= 2 chars AND isSearching=true renders the activity indicator", () => {
    mockUseSearch.mockReturnValue({ results: [], isSearching: true });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: "test" } });
    expect(screen.getByText("Searching…")).toBeTruthy();
    expect(screen.queryByText(/No notes match/i)).toBeNull();
  });

  it("CMM-UAT8-4: query >= 2 chars AND isSearching=false AND results=[] renders existing 'No notes match' state", () => {
    mockUseSearch.mockReturnValue({ results: [], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: "zz" } });
    expect(screen.getByText(/No notes match "zz"/)).toBeTruthy();
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("CMM-UAT8-5: query >= 2 chars AND isSearching=false AND results.length>0 renders results (no indicator, no empty state)", () => {
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = getPaletteInput();
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
    const input = getPaletteInput();
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
    const input = getPaletteInput();
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
    const input = getPaletteInput();

    const inputRow = input.parentElement;
    expect(inputRow).not.toBeNull();
    const spinner = inputRow?.querySelector('[aria-label="Searching"]');
    expect(spinner).toBeNull();
  });

  it("CMM-UAT8FU2-4: mode='search' + isSearching=true + results.length>0 keeps the prior result list rendered (stale-state preserved)", () => {
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: true });
    render(<CommandMenu {...defaultSearchProps} />);
    const input = getPaletteInput();
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
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: "zz" } });

    expect(screen.getByText("Searching…")).toBeTruthy();
  });
});


describe("CommandMenu — regression: scoped modes stay isolated", () => {
  it("mode='notes' still shows only note rows for a matching query (no cmd rows)", () => {
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Only Note", path: "only.md" }]);
    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "on" } });
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
  // D28.1 reverses D-14: owner mock-reconciliation adds a leading "Note" badge
  // so every quick-switcher row shares an aligned leading badge column.
  it("note rows carry a leading 'Note' kind badge (D28.1, reverses D-14)", () => {
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Meeting Notes", path: "meeting.md" }]);
    render(<CommandMenu {...defaultNoteProps} />);
    expect(screen.getByText("Note", { exact: true })).toBeTruthy();
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


describe("CMM-28.1-03-CATEGORY — command palette category sub-label", () => {
  it("renders item.category as a muted sub-label AND still renders the 'Cmd' badge", () => {
    const cmds = [
      {
        id: "split-right",
        label: "Split right",
        group: "Pane",
        category: "Layout",
        inPalette: true,
        inCheatSheet: true,
      },
    ];
    mockUseCommandPalette.mockReturnValue({
      filtered: vi.fn().mockReturnValue(cmds),
      execute: vi.fn(),
      isDisabled: vi.fn().mockReturnValue(false),
    });
    render(<CommandMenu {...defaultCmdProps} />);
    expect(screen.getByText("Layout", { exact: true })).toBeTruthy();
    expect(screen.getByText("Cmd")).toBeTruthy();
  });

  it("rows without a category render unchanged (no stray category text, 'Cmd' badge still present)", () => {
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
    expect(screen.getByText("Cmd")).toBeTruthy();
  });
});


describe("CMM-28-04-ROWS — two-line notes rows, match highlight, Vault subtitle (D-14/D-15/D-16)", () => {
  it("a note row's folder path renders as a second-line subtitle, not a same-line badge/right-align", () => {
    mockUseQuickSwitcher.mockReturnValue([
      { id: "n1", title: "Meeting Notes", path: "Work/meeting.md" },
    ]);
    render(<CommandMenu {...defaultNoteProps} />);
    expect(screen.getByText("Meeting Notes")).toBeTruthy();
    expect(screen.getByText("Work")).toBeTruthy();
  });

  it("a root-level note's subtitle renders the string 'Vault'", () => {
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Root Note", path: "root-note.md" }]);
    render(<CommandMenu {...defaultNoteProps} />);
    expect(screen.getByText("Vault")).toBeTruthy();
  });

  it("a title with matched query characters renders at least one accent-colored span", () => {
    mockUseQuickSwitcher.mockReturnValue([
      { id: "n1", title: "alpha", path: "alpha.md", matchIndexes: [0, 1] },
    ]);
    render(<CommandMenu {...defaultNoteProps} />);
    // Scope past the leading "Note" badge (accent color-mix background) to the
    // title's highlight span, which carries a bare `color: var(--color-accent)`.
    const highlighted = document.querySelector(
      'span[style*="var(--color-accent)"]:not([style*="color-mix"])',
    ) as HTMLElement | null;
    expect(highlighted).not.toBeNull();
    expect(highlighted?.textContent).toBe("al");
  });

  it("empty-query rows (no matchIndexes) render the title plainly, no highlight span", () => {
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Recent Note", path: "recent.md" }]);
    render(<CommandMenu {...defaultNoteProps} />);
    expect(screen.getByText("Recent Note")).toBeTruthy();
    // The leading "Note" badge legitimately uses accent (color-mix bg); exclude
    // it — this asserts no title *highlight* span exists.
    expect(
      document.querySelector('span[style*="var(--color-accent)"]:not([style*="color-mix"])'),
    ).toBeNull();
  });

  it("D28.1: a note row renders a leading 'Note' badge", () => {
    mockUseQuickSwitcher.mockReturnValue([
      { id: "n1", title: "Meeting Notes", path: "Work/meeting.md" },
    ]);
    render(<CommandMenu {...defaultNoteProps} />);
    expect(screen.getByText("Note", { exact: true })).toBeTruthy();
  });
});


describe("CMM-28-04-FOOTER — always-on footer legend (D-13, D28.1-01: 5 hints)", () => {
  it("renders the footer legend in notes mode with all five labels: navigate/open/create/split/dismiss", () => {
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Note A", path: "a.md" }]);
    render(<CommandMenu {...defaultNoteProps} />);
    expect(screen.getByText("navigate", { exact: true })).toBeTruthy();
    expect(screen.getByText("open", { exact: true })).toBeTruthy();
    expect(screen.getByText("create", { exact: true })).toBeTruthy();
    expect(screen.getByText("split", { exact: true })).toBeTruthy();
    expect(screen.getByText("dismiss", { exact: true })).toBeTruthy();
  });

  it("does NOT render the footer legend in commands mode", () => {
    render(<CommandMenu {...defaultCmdProps} />);
    expect(screen.queryByText("navigate")).toBeNull();
    expect(screen.queryByText("open")).toBeNull();
    expect(screen.queryByText("create")).toBeNull();
    expect(screen.queryByText("split")).toBeNull();
    expect(screen.queryByText("dismiss")).toBeNull();
  });
});


describe("CMM-28-04-ARIA — combobox/listbox/option roles (notes mode)", () => {
  it("input has role=combobox, aria-controls=quick-switcher-listbox, aria-expanded", () => {
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Note A", path: "a.md" }]);
    render(<CommandMenu {...defaultNoteProps} />);
    const input = screen.getByRole("combobox");
    expect(input.getAttribute("aria-controls")).toBe("quick-switcher-listbox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
  });

  it("input aria-activedescendant points at the selected option's id", () => {
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Note A", path: "a.md" }]);
    render(<CommandMenu {...defaultNoteProps} />);
    const input = screen.getByRole("combobox");
    expect(input.getAttribute("aria-activedescendant")).toBe("qs-option-n1");
  });

  it("list container has id=quick-switcher-listbox and role=listbox", () => {
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Note A", path: "a.md" }]);
    render(<CommandMenu {...defaultNoteProps} />);
    const listbox = document.getElementById("quick-switcher-listbox");
    expect(listbox).not.toBeNull();
    expect(listbox?.getAttribute("role")).toBe("listbox");
  });

  it("each note row has role=option, id=qs-option-{id}, aria-selected", () => {
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Note A", path: "a.md" }]);
    render(<CommandMenu {...defaultNoteProps} />);
    const option = document.getElementById("qs-option-n1");
    expect(option).not.toBeNull();
    expect(option?.getAttribute("role")).toBe("option");
    expect(option?.getAttribute("aria-selected")).toBe("true");
  });

  it("commands mode does NOT get combobox/listbox roles", () => {
    const cmds = [
      { id: "new-note", label: "New note", group: "File", inPalette: true, inCheatSheet: true },
    ];
    mockUseCommandPalette.mockReturnValue({
      filtered: vi.fn().mockReturnValue(cmds),
      execute: vi.fn(),
      isDisabled: vi.fn().mockReturnValue(false),
    });
    render(<CommandMenu {...defaultCmdProps} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.getElementById("quick-switcher-listbox")).toBeNull();
  });
});


describe("CMM-28-05-CREATE — create row (D-07/D-08)", () => {
  it("shows the create row for a novel query with no exact title match", () => {
    mockUseQuickSwitcher.mockReturnValue([]);
    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "Brand New" } });
    expect(screen.getByText('Create "Brand New"')).toBeTruthy();
  });

  it("D28.1-02: renders a green 'New' badge on the create row", () => {
    mockUseQuickSwitcher.mockReturnValue([]);
    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "Brand New" } });
    expect(screen.getByText("New", { exact: true })).toBeTruthy();
  });

  it("D28.1-02: the create title is NOT colored green (uses --color-fg, not --color-success)", () => {
    mockUseQuickSwitcher.mockReturnValue([]);
    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "Brand New" } });
    const title = screen.getByText('Create "Brand New"');
    expect(title.getAttribute("style")).toContain("var(--color-fg)");
    expect(title.getAttribute("style")).not.toContain("var(--color-success)");
  });

  it("D28.1-02: the create row renders no leading Plus/green icon", () => {
    mockUseQuickSwitcher.mockReturnValue([]);
    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "Brand New" } });
    const createRow = document.querySelector('[data-row-kind="create"]');
    expect(createRow).not.toBeNull();
    expect(createRow?.querySelector("svg")).toBeNull();
  });

  it("hides the create row when the query exactly (case-insensitively) matches an existing title", () => {
    mockUseFileTree.mockReturnValue({
      tree: {
        root: [{ kind: "note", id: "n1", title: "Existing Note", path: "existing.md" }],
      },
      loading: false,
      error: null,
    });
    mockUseQuickSwitcher.mockReturnValue([]);
    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "existing note" } });
    expect(screen.queryByText(/Create "/)).toBeNull();
  });

  it("hides the create row when the query is empty", () => {
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Note A", path: "a.md" }]);
    render(<CommandMenu {...defaultNoteProps} />);
    expect(screen.queryByText(/Create "/)).toBeNull();
  });

  it("renders 'New note · in vault root' subtitle when no active note is open", () => {
    mockUseQuickSwitcher.mockReturnValue([]);
    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "Brand New" } });
    expect(screen.getByText("New note · in vault root")).toBeTruthy();
  });

  it("renders 'New note · in {folder}' subtitle when the active note lives in a folder", () => {
    mockUseTreeStore.mockImplementation((selector: (s: Record<string, unknown>) => unknown) => {
      const state = {
        setActiveNote: mockSetActiveNote,
        recordOpenedNote: mockRecordOpenedNote,
        recentlyOpenedNoteIds: [],
        activeTagFilter: null,
        setSearchActive: vi.fn(),
        setSearchQuery: vi.fn(),
        setSearchResults: vi.fn(),
        activeNoteId: "n1",
      };
      return selector(state);
    });
    mockUseFileTree.mockReturnValue({
      tree: {
        root: [
          {
            kind: "folder",
            path: "Work",
            name: "Work",
            children: [{ kind: "note", id: "n1", title: "Existing", path: "Work/existing.md" }],
          },
        ],
      },
      loading: false,
      error: null,
    });
    mockUseQuickSwitcher.mockReturnValue([]);
    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "Brand New" } });
    expect(screen.getByText("New note · in Work")).toBeTruthy();
  });
});


describe("CMM-28-05-KEYS — Enter/Shift+Enter/Cmd+Shift+Enter wiring (D-05/07/09/10/11)", () => {
  it("plain Enter on the create row creates + opens in the active pane, then closes", async () => {
    const onOpenChange = vi.fn();
    mockCreateNote.mockResolvedValue({ id: "new-1", title: "Brand New", path: "Brand New.md" });
    mockUseQuickSwitcher.mockReturnValue([]);

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    fireEvent.change(getPaletteInput(), { target: { value: "Brand New" } });
    fireEvent.keyDown(getPaletteInput(), { key: "Enter" });

    await vi.waitFor(() => {
      expect(mockCreateNote).toHaveBeenCalledWith("", "Brand New");
    });
    expect(mockOpenInActivePane).toHaveBeenCalledWith("new-1");
    expect(mockRecordOpenedNote).toHaveBeenCalledWith("new-1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Shift+Enter with a novel query calls createNote with the active folder + query, then opens + closes", async () => {
    const onOpenChange = vi.fn();
    mockCreateNote.mockResolvedValue({ id: "new-2", title: "Another", path: "Another.md" });
    mockUseQuickSwitcher.mockReturnValue([{ id: "n0", title: "Unrelated", path: "u.md" }]);

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    fireEvent.change(getPaletteInput(), { target: { value: "Another" } });
    fireEvent.keyDown(getPaletteInput(), { key: "Enter", shiftKey: true });

    await vi.waitFor(() => {
      expect(mockCreateNote).toHaveBeenCalledWith("", "Another");
    });
    expect(mockOpenInActivePane).toHaveBeenCalledWith("new-2");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Shift+Enter with an existing (differently-cased) title opens it instead of creating a duplicate", () => {
    const onOpenChange = vi.fn();
    mockUseFileTree.mockReturnValue({
      tree: {
        root: [{ kind: "note", id: "n1", title: "Existing Note", path: "existing.md" }],
      },
      loading: false,
      error: null,
    });
    mockUseQuickSwitcher.mockReturnValue([]);

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    fireEvent.change(getPaletteInput(), { target: { value: "existing note" } });
    fireEvent.keyDown(getPaletteInput(), { key: "Enter", shiftKey: true });

    expect(mockOpenInActivePane).toHaveBeenCalledWith("n1");
    expect(mockCreateNote).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Cmd/Ctrl+Shift+Enter on a note row opens it in a new split (unconditional, even if already open)", () => {
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Meeting Notes", path: "meeting.md" }]);

    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "Meeting" } });
    fireEvent.keyDown(getPaletteInput(), { key: "Enter", ctrlKey: true, shiftKey: true });

    expect(mockOpenNoteInNewSplit).toHaveBeenCalledWith("n1", "row");
    expect(mockOpenInActivePane).not.toHaveBeenCalled();
  });

  it("Cmd/Ctrl+Shift+Enter on the create row creates the note, then opens it in a new split", async () => {
    mockCreateNote.mockResolvedValue({ id: "new-3", title: "Split Note", path: "Split Note.md" });
    mockUseQuickSwitcher.mockReturnValue([]);

    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "Split Note" } });
    fireEvent.keyDown(getPaletteInput(), { key: "Enter", ctrlKey: true, shiftKey: true });

    await vi.waitFor(() => {
      expect(mockCreateNote).toHaveBeenCalledWith("", "Split Note");
    });
    expect(mockOpenNoteInNewSplit).toHaveBeenCalledWith("new-3", "row");
  });

  it("empty query makes Shift+Enter a no-op (no create, no open, does not close)", () => {
    const onOpenChange = vi.fn();
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Note A", path: "a.md" }]);

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    fireEvent.keyDown(getPaletteInput(), { key: "Enter", shiftKey: true });

    expect(mockCreateNote).not.toHaveBeenCalled();
    expect(mockOpenInActivePane).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("empty query makes Cmd/Ctrl+Shift+Enter a no-op (no split, does not close)", () => {
    const onOpenChange = vi.fn();
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Note A", path: "a.md" }]);

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    fireEvent.keyDown(getPaletteInput(), { key: "Enter", ctrlKey: true, shiftKey: true });

    expect(mockOpenNoteInNewSplit).not.toHaveBeenCalled();
    expect(mockCreateNote).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("plain Enter on a note row is unchanged: opens + records + closes (no create wiring interference)", () => {
    const onOpenChange = vi.fn();
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Meeting Notes", path: "meeting.md" }]);

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);
    fireEvent.keyDown(getPaletteInput(), { key: "Enter" });

    expect(mockOpenInActivePane).toHaveBeenCalledWith("n1");
    expect(mockCreateNote).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a 409 case-collision from createNote surfaces via the shared toast without crashing", async () => {
    const { TreeMutationError } = await import("../lib/useTreeMutations");
    mockCreateNote.mockRejectedValue(new TreeMutationError("case_collision", "boom", 409));
    mockUseQuickSwitcher.mockReturnValue([]);

    render(<CommandMenu {...defaultNoteProps} />);
    fireEvent.change(getPaletteInput(), { target: { value: "Dup" } });
    fireEvent.keyDown(getPaletteInput(), { key: "Enter", shiftKey: true });

    await vi.waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "That name already exists." }),
      );
    });
    expect(mockOpenInActivePane).not.toHaveBeenCalled();
  });
});


describe("CMM-CLICK — mouse-click activation path (IN-02)", () => {
  it("CMM-CLICK-1: clicking a note row calls openTab(id) and never setActiveNote", () => {
    const onOpenChange = vi.fn();
    mockUseQuickSwitcher.mockReturnValue([{ id: "n1", title: "Meeting Notes", path: "meeting.md" }]);

    render(<CommandMenu {...defaultNoteProps} onOpenChange={onOpenChange} />);

    const noteRow = document.querySelector('[data-row-kind="note"]') as HTMLElement | null;
    expect(noteRow).not.toBeNull();
    fireEvent.click(noteRow as HTMLElement);

    expect(mockOpenInActivePane).toHaveBeenCalledWith("n1");
    expect(mockSetActiveNote).not.toHaveBeenCalled();
    expect(mockRecordOpenedNote).toHaveBeenCalledWith("n1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("CMM-CLICK-2: clicking a search-result row calls openTab(id) and never setActiveNote (locks WR-01)", () => {
    const onOpenChange = vi.fn();
    const FTS5_HIT = {
      id: "n-click-search-1",
      title: "Hello World",
      path: "notes/hello.md",
      excerpt_html: "this is a <mark>hello</mark> excerpt",
      matching_tags: [],
      rank: 1,
      modified_at: "2026-05-16T00:00:00Z",
    };
    mockUseSearch.mockReturnValue({ results: [FTS5_HIT], isSearching: false });

    render(
      <CommandMenu open={true} onOpenChange={onOpenChange} mode="search" actions={{}} />,
    );
    fireEvent.change(getPaletteInput(), { target: { value: "he" } });

    const searchRow = document.querySelector('[data-row-kind="search-result"]') as HTMLElement | null;
    expect(searchRow).not.toBeNull();
    fireEvent.click(searchRow as HTMLElement);

    expect(mockOpenInActivePane).toHaveBeenCalledWith(FTS5_HIT.id);
    expect(mockSetActiveNote).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
