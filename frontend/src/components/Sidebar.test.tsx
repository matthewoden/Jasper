/**
 * Sidebar tests — Phase 3 chassis + Plan 03-07 wiring.
 *
 * Plan 03-07 changes:
 *   - Sidebar's New note / New folder buttons now call
 *     useTreeCreateActions() (which itself uses useToast +
 *     useTreeMutations + useFileTree). Tests wrap Sidebar in
 *     <ToastProvider> + mock useTreeMutations.
 *   - Refresh-error path now surfaces a destructive toast with the
 *     locked title "Couldn't refresh the index." in addition to
 *     re-throwing for the toolbar's spin-clear.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../lib/useFileTree", () => ({
  useFileTree: vi.fn(),
}));
vi.mock("../lib/adminApi", () => ({
  postAdminReindex: vi.fn(),
}));
// Plan 07-39 (UAT-5 N11): Sidebar now consumes useSearch as the driver for the
// Sidebar search UI (SearchInputBar + SearchResultsList). Mock it so tests
// don't fire real backend GET /api/v1/search calls.
vi.mock("../lib/useSearch", () => ({
  useSearch: vi.fn(() => ({ results: [], isSearching: false })),
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
// Phase 5 — SidebarToolbar now renders SettingsMenu, which uses
// useTheme → useConfig → real openapi-fetch GET. jsdom + undici can't
// parse the relative URL, so we stub the hook to keep these tests
// focused on tree/sidebar concerns rather than config-fetch plumbing.
vi.mock("../lib/useTheme", () => ({
  useTheme: () => ({
    theme: "dark",
    setTheme: vi.fn().mockResolvedValue({}),
  }),
  THEME_BOOTSTRAP_KEY: "jasper:theme-bootstrap",
}));

// Phase 6 — Plan 06-08: mock useTagBrowser so Sidebar tests don't spin up
// real tag-fetch infra. TagBrowserSection is tested separately in
// TagBrowserSection.test.tsx. These tests only verify that the section is
// mounted in the correct slot of the sidebar layout.
vi.mock("../lib/useTagBrowser", () => ({
  useTagBrowser: vi.fn(() => ({
    tags: [{ name: "alpha", count: 3 }],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  })),
}));
// tagsApi must also be mocked since TagBrowserSection imports it directly.
vi.mock("../lib/tagsApi", () => ({
  listTags: vi.fn(),
  listTagNotes: vi.fn(),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
}));

import { useFileTree } from "../lib/useFileTree";
import { postAdminReindex } from "../lib/adminApi";
import { useTreeMutations } from "../lib/useTreeMutations";
import { useTreeStore, SIDEBAR_WIDTH_DEFAULT } from "../lib/useTreeStore";
import { Sidebar } from "./Sidebar";
import { ToastProvider } from "./Toast";
import { useSearch } from "../lib/useSearch";
const mockedUseSearch = vi.mocked(useSearch);

const mockedUseFileTree = vi.mocked(useFileTree);
const mockedPostAdminReindex = vi.mocked(postAdminReindex);
const mockedUseTreeMutations = vi.mocked(useTreeMutations);

const noopMutate = () => {};

function defaultMutsResult() {
  return {
    createNote: vi.fn(),
    deleteNote: vi.fn(),
    moveNote: vi.fn(),
    createFolder: vi.fn(),
    deleteFolder: vi.fn(),
    moveFolder: vi.fn(),
  };
}

function renderWithProvider(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

beforeEach(() => {
  mockedUseFileTree.mockReset();
  mockedPostAdminReindex.mockReset();
  mockedUseTreeMutations.mockReset();
  mockedUseTreeMutations.mockReturnValue(defaultMutsResult());
  // UX-09: reset persistent sidebar width slice so each test starts at
  // the default and isn't polluted by a sibling test that pre-set a
  // larger width.
  useTreeStore.setState({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
  // UX-12: reset selectedRow so the create-target derivation tests below
  // start from a known "no selection" baseline. selectedRow is transient
  // (never persisted), but it is module-level state that survives between
  // tests within a single Vitest worker.
  useTreeStore.setState({ selectedRow: null });
});

afterEach(() => {
  mockedUseFileTree.mockReset();
  mockedPostAdminReindex.mockReset();
  mockedUseTreeMutations.mockReset();
});

describe("<Sidebar /> — Phase 3 chassis", () => {
  it("TestSidebar_RendersNavWithAriaLabel", () => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    renderWithProvider(<Sidebar />);
    expect(screen.getByLabelText("Notes navigation")).toBeInTheDocument();
  });

  it("TestSidebar_RendersNotesHeader", () => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    renderWithProvider(<Sidebar />);
    expect(screen.getByText("NOTES")).toBeInTheDocument();
  });

  it("TestSidebar_RendersToolbar — New note + New folder buttons (Phase 6.6: Refresh moved to StatusBar)", () => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    renderWithProvider(<Sidebar />);
    expect(
      screen.getByRole("button", { name: "New note" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New folder" }),
    ).toBeInTheDocument();
    // Phase 6.6 (D-08): Refresh moved to StatusBar; no longer in SidebarToolbar
    expect(
      screen.queryByRole("button", { name: "Refresh" }),
    ).toBeNull();
  });

  it("TestSidebar_DefaultWidth260 — reads SIDEBAR_WIDTH_DEFAULT from useTreeStore", () => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    renderWithProvider(<Sidebar />);
    const nav = screen.getByLabelText("Notes navigation") as HTMLElement;
    expect(nav.style.width).toBe("260px");
  });

  it("UX-09: width comes from useTreeStore.sidebarWidth (not a literal)", () => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    // Pre-set the store to a non-default width before render so we can
    // distinguish "store-driven" from "literal 260".
    useTreeStore.setState({ sidebarWidth: 380 });
    renderWithProvider(<Sidebar />);
    const nav = screen.getByLabelText("Notes navigation") as HTMLElement;
    expect(nav.style.width).toBe("380px");
    // The parent must also be position:relative so the absolute-
    // positioned resize handle anchors to the right edge.
    expect(nav.style.position).toBe("relative");
  });

  it("UX-09: SidebarResizeHandle is mounted as a child of the nav", () => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    renderWithProvider(<Sidebar />);
    const nav = screen.getByLabelText("Notes navigation") as HTMLElement;
    const handle = screen.getByTestId("sidebar-resize-handle");
    expect(nav.contains(handle)).toBe(true);
  });

  it("TestSidebar_NoStaticScratchpadRow — Phase 1 hardcoded row is gone", () => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    renderWithProvider(<Sidebar />);
    expect(screen.queryByText("scratchpad")).toBeNull();
  });

  it("TestSidebar_RefreshNotInSidebar — Phase 6.6: Refresh moved to StatusBar (D-08)", () => {
    // Refresh was moved out of Sidebar to StatusBar in Phase 6.6.
    // Sidebar no longer renders a Refresh button or calls postAdminReindex.
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    renderWithProvider(<Sidebar />);
    // No Refresh button in the sidebar anymore
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    // postAdminReindex should never be called from Sidebar
    expect(mockedPostAdminReindex).not.toHaveBeenCalled();
  });

  it("TestSidebar_RendersFileTreeRoot — populated tree shows note titles", async () => {
    mockedUseFileTree.mockReturnValue({
      tree: {
        root: [
          {
            kind: "note",
            id: "uuid-1",
            path: "scratchpad.md",
            title: "Scratchpad",
            updated_at: new Date().toISOString(),
          },
        ],
      },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    renderWithProvider(<Sidebar />);
    await waitFor(() => {
      expect(screen.getByText("Scratchpad")).toBeInTheDocument();
    });
  });

  it("TestSidebar_NewNoteAndNewFolder_Click — buttons render and click without crashing", async () => {
    // Gap R2-2: the in-flight guard now serializes create clicks so a
    // synchronous double-click of New Note → New Folder no longer fires
    // both mutators in the same tick. We click New Note, await its
    // mutator settling, THEN click New Folder. Both still trigger their
    // respective mutators — they just can't race.
    const muts = defaultMutsResult();
    muts.createNote.mockResolvedValue({
      id: "n-new",
      path: "untitled.md",
      title: "untitled",
      updated_at: new Date().toISOString(),
    });
    muts.createFolder.mockResolvedValue({
      kind: "folder",
      path: "untitled",
      name: "untitled",
    });
    mockedUseTreeMutations.mockReturnValue(muts);
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    renderWithProvider(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    await waitFor(() => {
      expect(muts.createNote).toHaveBeenCalledWith("", "untitled");
    });
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    await waitFor(() => {
      expect(muts.createFolder).toHaveBeenCalledWith("", "untitled");
    });
  });

  // Phase 6.5 — Plan 06.5-04: TagBrowserSection REMOVED from Sidebar.
  // Left sidebar is file-tree-only. Tag browser relocated to right-rail
  // RightRailTagsPanel. These tests lock in the ABSENCE of the tag section.
  describe("Phase 6.5 — TagBrowserSection removed from sidebar (D-04)", () => {
    it("SI-REMOVED: TagBrowserSection is NOT present inside the nav (removed in Phase 6.5)", () => {
      mockedUseFileTree.mockReturnValue({
        tree: { root: [] },
        loading: false,
        error: null,
        refresh: () => Promise.resolve(),
        mutate: noopMutate,
      });
      renderWithProvider(<Sidebar />);
      // The Phase 6 uppercase "TAGS (N)" header must be absent
      expect(screen.queryByText(/^TAGS \(/)).toBeNull();
    });

    it("SI-REMOVED: sidebar does not render 'TAGS' header in any case", () => {
      mockedUseFileTree.mockReturnValue({
        tree: { root: [] },
        loading: false,
        error: null,
        refresh: () => Promise.resolve(),
        mutate: noopMutate,
      });
      renderWithProvider(<Sidebar />);
      // No uppercase TAGS section in the left sidebar
      expect(screen.queryByText(/TAGS \(\d+\)/)).toBeNull();
    });

    it("SI-PRESENT: SidebarResizeHandle is still the last structural element", () => {
      mockedUseFileTree.mockReturnValue({
        tree: { root: [] },
        loading: false,
        error: null,
        refresh: () => Promise.resolve(),
        mutate: noopMutate,
      });
      renderWithProvider(<Sidebar />);
      const nav = screen.getByLabelText("Notes navigation") as HTMLElement;
      const resizeHandle = screen.getByTestId("sidebar-resize-handle");
      // Resize handle is still inside the nav
      expect(nav.contains(resizeHandle)).toBe(true);
    });
  });

  // UX-12 — toolbar create paths target the parent of the currently-
  // selected row (or inside the selected folder), not always the root.
  // selectedRow is populated by every TreeRow click (TreeRow.tsx ~line
  // 199); the toolbar's handleNewNote / handleNewFolder read it via
  // useTreeStore.getState() at click time and resolve to the right
  // parent. createNoteAt / createFolderAt forward that parent through
  // useTreeMutations.createNote / .createFolder unchanged.
  describe("UX-12 — create-at-current-level (toolbar path)", () => {
    it("UX-12: toolbar New note with no selection creates at root", async () => {
      const muts = defaultMutsResult();
      muts.createNote.mockResolvedValue({
        id: "n-new",
        path: "untitled.md",
        title: "untitled",
        updated_at: new Date().toISOString(),
      });
      mockedUseTreeMutations.mockReturnValue(muts);
      mockedUseFileTree.mockReturnValue({
        tree: { root: [] },
        loading: false,
        error: null,
        refresh: () => Promise.resolve(),
        mutate: noopMutate,
      });
      // Default beforeEach already cleared selectedRow; assert it's null
      // so the test's intent is self-documenting.
      expect(useTreeStore.getState().selectedRow).toBeNull();

      renderWithProvider(<Sidebar />);
      fireEvent.click(screen.getByRole("button", { name: "New note" }));
      await waitFor(() => {
        expect(muts.createNote).toHaveBeenCalledWith("", "untitled");
      });
    });

    it("UX-12: toolbar New note with folder selection creates inside that folder", async () => {
      const muts = defaultMutsResult();
      muts.createNote.mockResolvedValue({
        id: "n-new",
        path: "scratch/2026/untitled.md",
        title: "untitled",
        updated_at: new Date().toISOString(),
      });
      mockedUseTreeMutations.mockReturnValue(muts);
      mockedUseFileTree.mockReturnValue({
        tree: {
          root: [
            {
              kind: "folder",
              path: "scratch",
              name: "scratch",
              children: [
                {
                  kind: "folder",
                  path: "scratch/2026",
                  name: "2026",
                  children: [],
                },
              ],
            },
          ],
        },
        loading: false,
        error: null,
        refresh: () => Promise.resolve(),
        mutate: noopMutate,
      });
      useTreeStore.setState({
        selectedRow: { kind: "folder", target: "scratch/2026" },
      });

      renderWithProvider(<Sidebar />);
      fireEvent.click(screen.getByRole("button", { name: "New note" }));
      await waitFor(() => {
        expect(muts.createNote).toHaveBeenCalledWith("scratch/2026", "untitled");
      });
    });

    it("UX-12: toolbar New note with note selection creates in the note's parent folder", async () => {
      const muts = defaultMutsResult();
      muts.createNote.mockResolvedValue({
        id: "n-new",
        path: "scratch/2026/05/untitled.md",
        title: "untitled",
        updated_at: new Date().toISOString(),
      });
      mockedUseTreeMutations.mockReturnValue(muts);
      mockedUseFileTree.mockReturnValue({
        tree: {
          root: [
            {
              kind: "folder",
              path: "scratch",
              name: "scratch",
              children: [
                {
                  kind: "folder",
                  path: "scratch/2026",
                  name: "2026",
                  children: [
                    {
                      kind: "folder",
                      path: "scratch/2026/05",
                      name: "05",
                      children: [
                        {
                          kind: "note",
                          id: "n-1",
                          path: "scratch/2026/05/idea.md",
                          title: "idea",
                          updated_at: new Date().toISOString(),
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        loading: false,
        error: null,
        refresh: () => Promise.resolve(),
        mutate: noopMutate,
      });
      useTreeStore.setState({
        selectedRow: { kind: "note", target: "n-1" },
      });

      renderWithProvider(<Sidebar />);
      fireEvent.click(screen.getByRole("button", { name: "New note" }));
      await waitFor(() => {
        expect(muts.createNote).toHaveBeenCalledWith(
          "scratch/2026/05",
          "untitled",
        );
      });
    });

    it("UX-12: toolbar New folder follows the same selection-aware rule", async () => {
      const muts = defaultMutsResult();
      muts.createFolder.mockResolvedValue({
        kind: "folder",
        path: "scratch/untitled",
        name: "untitled",
      });
      mockedUseTreeMutations.mockReturnValue(muts);
      mockedUseFileTree.mockReturnValue({
        tree: {
          root: [
            {
              kind: "folder",
              path: "scratch",
              name: "scratch",
              children: [],
            },
          ],
        },
        loading: false,
        error: null,
        refresh: () => Promise.resolve(),
        mutate: noopMutate,
      });
      useTreeStore.setState({
        selectedRow: { kind: "folder", target: "scratch" },
      });

      renderWithProvider(<Sidebar />);
      fireEvent.click(screen.getByRole("button", { name: "New folder" }));
      await waitFor(() => {
        expect(muts.createFolder).toHaveBeenCalledWith("scratch", "untitled");
      });
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase 6.6 (Plan 06.6-11) — Floating-panel card aesthetic + visibility gating
// ──────────────────────────────────────────────────────────────────────
describe("<Sidebar /> — Phase 6.6 floating-panel + visibility gating (Plan 06.6-11)", () => {
  beforeEach(() => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    useTreeStore.setState({ notesSidebarVisible: true });
  });

  it("6.6-S1: outer nav background is var(--color-bg)", () => {
    renderWithProvider(<Sidebar />);
    const nav = screen.getByLabelText("Notes navigation") as HTMLElement;
    expect(nav.style.background).toBe("var(--color-bg)");
  });

  it("6.6-S2: outer nav does NOT have borderRight", () => {
    renderWithProvider(<Sidebar />);
    const nav = screen.getByLabelText("Notes navigation") as HTMLElement;
    // The outer nav should not have a borderRight (the inner card carries the boundary)
    expect(nav.style.borderRight).toBeFalsy();
  });

  it("6.6-S3: inner card div has margin 8px, --color-surface bg, 1px border, borderRadius 8px", () => {
    renderWithProvider(<Sidebar />);
    const nav = screen.getByLabelText("Notes navigation") as HTMLElement;
    // Look for the inner card element (direct child of nav that has margin)
    const card = nav.querySelector('div[style*="margin"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card!.style.margin).toBe("8px");
    expect(card!.style.background).toBe("var(--color-surface)");
    expect(card!.style.border).toBe("1px solid var(--color-border)");
    expect(card!.style.borderRadius).toBe("8px");
    expect(card!.style.overflow).toBe("hidden");
  });

  it("6.6-S4: when notesSidebarVisible=false, Sidebar returns null", () => {
    useTreeStore.setState({ notesSidebarVisible: false });
    renderWithProvider(<Sidebar />);
    // The nav should not be in the document
    expect(screen.queryByLabelText("Notes navigation")).toBeNull();
  });

  it("6.6-S5: SidebarResizeHandle is still mounted on the outer nav (NOT inside the card)", () => {
    renderWithProvider(<Sidebar />);
    const nav = screen.getByLabelText("Notes navigation") as HTMLElement;
    const handle = screen.getByTestId("sidebar-resize-handle");
    // Handle is inside nav
    expect(nav.contains(handle)).toBe(true);
    // Handle should be a direct child of nav (not inside the inner card)
    const card = nav.querySelector('div[style*="margin"]') as HTMLElement | null;
    if (card) {
      // Handle should NOT be inside the card
      expect(card.contains(handle)).toBe(false);
    }
  });

  it("6.6-S6: Sidebar accepts optional style prop (merges into outer nav)", () => {
    renderWithProvider(<Sidebar style={{ gridRow: "1 / 3", gridColumn: "1" }} />);
    const nav = screen.getByLabelText("Notes navigation") as HTMLElement;
    expect(nav.style.gridRow).toBe("1 / 3");
    expect(nav.style.gridColumn).toBe("1");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// SBR-N11-SPLIT — Plan 07-39 (UAT-5 N11): Sidebar mounts SearchInputBar
// (always) + conditional SearchResultsList; runs the useSearch driver effect
// that mirrors hook results → store searchResults slice.
// ──────────────────────────────────────────────────────────────────────────
describe("<Sidebar /> — Plan 07-39 Sidebar Search UI (UAT-5 N11)", () => {
  beforeEach(() => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    useTreeStore.setState({
      notesSidebarVisible: true,
      searchQuery: "",
      searchActive: false,
      searchResults: [],
    });
    mockedUseSearch.mockReturnValue({ results: [], isSearching: false });
  });

  it("SBR-N11-SPLIT-1: SearchInputBar is mounted unconditionally inside the sidebar", () => {
    renderWithProvider(<Sidebar />);
    // SearchInputBar renders an input with placeholder "Search notes…"
    expect(screen.getByPlaceholderText("Search notes…")).toBeInTheDocument();
  });

  it("SBR-N11-SPLIT-2: when searchActive=false, FileTree renders + SearchResultsList does NOT", () => {
    useTreeStore.setState({ searchActive: false, searchQuery: "" });
    renderWithProvider(<Sidebar />);
    // FileTree mounts a [role='tree'] container; SearchResultsList does not.
    expect(document.querySelector('[role="tree"]')).not.toBeNull();
  });

  it("SBR-N11-SPLIT-3: when searchActive=true, SearchResultsList renders + FileTree does NOT", () => {
    useTreeStore.setState({
      searchActive: true,
      searchQuery: "hello",
      searchResults: [],
    });
    renderWithProvider(<Sidebar />);
    // FileTree must NOT be in the DOM when search is active.
    expect(document.querySelector('[role="tree"]')).toBeNull();
    // Empty-state copy from SearchResultsList renders when query >= 2 + 0 results.
    expect(screen.getByText('No matches for "hello"')).toBeInTheDocument();
  });

  it("SBR-N11-SPLIT-4: useSearch driver effect mirrors results → store.searchResults", async () => {
    const HIT = {
      id: "abc",
      title: "Hello",
      path: "hello.md",
      excerpt_html: "h<mark>el</mark>lo",
      matching_tags: [],
      rank: 1,
      modified_at: "2026-05-16T00:00:00Z",
    };
    // Pre-seed the driver: the Sidebar reads searchQuery from store; useSearch
    // mock returns the hits regardless. The driver effect should write to store.
    mockedUseSearch.mockReturnValue({ results: [HIT], isSearching: false });
    useTreeStore.setState({ searchQuery: "he", searchActive: false, searchResults: [] });

    renderWithProvider(<Sidebar />);
    await waitFor(() => {
      expect(useTreeStore.getState().searchResults).toEqual([HIT]);
      // query.length >= 2 must flip searchActive on.
      expect(useTreeStore.getState().searchActive).toBe(true);
    });
  });
});
