/**
 * Sidebar tests — New note / New folder wiring and layout contracts.
 * Tests wrap Sidebar in ToastProvider and mock useTreeMutations.
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


vi.mock("../lib/useTheme", () => ({
  useTheme: () => ({
    theme: "dark",
    setTheme: vi.fn().mockResolvedValue({}),
  }),
  THEME_BOOTSTRAP_KEY: "jasper:theme-bootstrap",
}));


vi.mock("../lib/useTagBrowser", () => ({
  useTagBrowser: vi.fn(() => ({
    tags: [{ name: "alpha", count: 3 }],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../lib/tagsApi", () => ({
  listTags: vi.fn(),
  listTagNotes: vi.fn(),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
}));

const mockDisplayName: string | null = "work-vault";
vi.mock("../lib/useVaultPicker", () => ({
  useVaultPicker: () => ({
    isOpen: false,
    open: vi.fn(),
    close: vi.fn(),
    current: mockDisplayName === null ? null : { display_name: mockDisplayName },
    recents: [],
    banner: "",
    isLoading: false,
    refresh: vi.fn(),
  }),
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
    moveFile: vi.fn(),
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
  useTreeStore.setState({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
  useTreeStore.setState({ selectedRow: null });
  useTreeStore.setState({
    allCollapsed: false,
    expanded: new Set(),
    collapseAllNonce: 0,
    expandAllNonce: 0,
  });
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

  it("TestSidebar_RendersTabRowHeader — 40px header hosts the SidebarTabRow (Phase 27 NAV-01, replaces the vault-name header)", () => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    renderWithProvider(<Sidebar />);
    expect(screen.getByTestId("sidebar-tab-row")).toBeInTheDocument();
    expect(screen.queryByText("work-vault")).toBeNull();
    expect(screen.queryByText("NOTES")).toBeNull();
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
    useTreeStore.setState({ sidebarWidth: 380 });
    renderWithProvider(<Sidebar />);
    const nav = screen.getByLabelText("Notes navigation") as HTMLElement;
    expect(nav.style.width).toBe("380px");
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
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    renderWithProvider(<Sidebar />);
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
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

  describe("Phase 27 follow-up item 1 — Collapse-all becomes a toggle", () => {
    it("renders ChevronsDownUp (Collapse all) by default", () => {
      mockedUseFileTree.mockReturnValue({
        tree: { root: [] },
        loading: false,
        error: null,
        refresh: () => Promise.resolve(),
        mutate: noopMutate,
      });
      renderWithProvider(<Sidebar />);
      expect(
        screen.getByRole("button", { name: "Collapse all" }),
      ).toBeInTheDocument();
    });

    it("clicking Collapse-all calls collapseAllFolders and flips the icon to Expand all", () => {
      mockedUseFileTree.mockReturnValue({
        tree: { root: [] },
        loading: false,
        error: null,
        refresh: () => Promise.resolve(),
        mutate: noopMutate,
      });
      renderWithProvider(<Sidebar />);
      fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
      expect(useTreeStore.getState().allCollapsed).toBe(true);
      expect(
        screen.getByRole("button", { name: "Expand all" }),
      ).toBeInTheDocument();
    });

    it("clicking again (while allCollapsed) calls expandAllFolders with every folder path and flips the icon back", () => {
      mockedUseFileTree.mockReturnValue({
        tree: {
          root: [
            {
              kind: "folder",
              path: "projects",
              name: "projects",
              children: [
                { kind: "folder", path: "projects/2026", name: "2026", children: [] },
              ],
            },
          ],
        },
        loading: false,
        error: null,
        refresh: () => Promise.resolve(),
        mutate: noopMutate,
      });
      useTreeStore.setState({ allCollapsed: true, expanded: new Set() });
      renderWithProvider(<Sidebar />);
      fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
      expect(useTreeStore.getState().allCollapsed).toBe(false);
      expect([...useTreeStore.getState().expanded].sort()).toEqual([
        "projects",
        "projects/2026",
      ]);
      expect(
        screen.getByRole("button", { name: "Collapse all" }),
      ).toBeInTheDocument();
    });
  });

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
      expect(nav.contains(resizeHandle)).toBe(true);
    });
  });

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
    expect(nav.style.borderRight).toBeFalsy();
  });

  it("6.6-S3: inner panel is flush — --color-surface bg, border-right only, hidden overflow (owner-approved 23-03)", () => {
    renderWithProvider(<Sidebar />);
    const nav = screen.getByLabelText("Notes navigation") as HTMLElement;
    const card = nav.querySelector('div[style*="var(--color-surface)"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card!.style.background).toBe("var(--color-surface)");
    expect(card!.style.borderRight).toBe("1px solid var(--color-border)");
    expect(card!.style.overflow).toBe("hidden");
    // Phase 23-03 flush redesign superseded the Phase 6.6 floating card:
    // no margin, no full border shorthand, no border-radius.
    expect(card!.style.margin).toBe("");
    expect(card!.style.border).toBe("");
    expect(card!.style.borderRadius).toBe("");
  });

  it("6.6-S4: when notesSidebarVisible=false, Sidebar returns null", () => {
    useTreeStore.setState({ notesSidebarVisible: false });
    renderWithProvider(<Sidebar />);
    expect(screen.queryByLabelText("Notes navigation")).toBeNull();
  });

  it("6.6-S5: SidebarResizeHandle is still mounted on the outer nav (NOT inside the card)", () => {
    renderWithProvider(<Sidebar />);
    const nav = screen.getByLabelText("Notes navigation") as HTMLElement;
    const handle = screen.getByTestId("sidebar-resize-handle");
    expect(nav.contains(handle)).toBe(true);
    const card = nav.querySelector('div[style*="var(--color-surface)"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card!.contains(handle)).toBe(false);
  });

  it("6.6-S6: Sidebar accepts optional style prop (merges into outer nav)", () => {
    renderWithProvider(<Sidebar style={{ gridRow: "1 / 3", gridColumn: "1" }} />);
    const nav = screen.getByLabelText("Notes navigation") as HTMLElement;
    expect(nav.style.gridRow).toBe("1 / 3");
    expect(nav.style.gridColumn).toBe("1");
  });
});


describe("<Sidebar /> — Plan 07-40 reversal of Sidebar Search UI (UAT-6)", () => {
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

  it("SBR-UAT6-UNMOUNT-1: SearchInputBar is NOT mounted in the sidebar (any tree state)", () => {
    renderWithProvider(<Sidebar />);
    expect(screen.queryByPlaceholderText("Search notes…")).toBeNull();
  });

  it("SBR-UAT6-UNMOUNT-1b: SearchInputBar is NOT mounted even when searchActive=true", () => {
    useTreeStore.setState({
      searchActive: true,
      searchQuery: "hello",
      searchResults: [],
    });
    renderWithProvider(<Sidebar />);
    expect(screen.queryByPlaceholderText("Search notes…")).toBeNull();
  });

  it("SBR-UAT6-UNMOUNT-2: SearchResultsList is NOT rendered regardless of searchActive", () => {
    useTreeStore.setState({
      searchActive: true,
      searchQuery: "hello",
      searchResults: [],
    });
    renderWithProvider(<Sidebar />);
    expect(screen.queryByText('No matches for "hello"')).toBeNull();
  });

  it("SBR-UAT6-UNMOUNT-3: FileTree is always rendered (no conditional on searchActive)", () => {
    useTreeStore.setState({
      searchActive: true,
      searchQuery: "hello",
      searchResults: [],
    });
    mockedUseFileTree.mockReturnValue({
      tree: {
        root: [
          {
            kind: "note",
            id: "n1",
            path: "first.md",
            title: "First",
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
    expect(document.querySelector('[role="tree"]')).not.toBeNull();
  });

  it("SBR-UAT6-UNMOUNT-4: useSearch driver effects do NOT run (no store writes from Sidebar)", async () => {
    const HIT = {
      id: "abc",
      title: "Hello",
      path: "hello.md",
      excerpt_html: "h<mark>el</mark>lo",
      matching_tags: [],
      rank: 1,
      modified_at: "2026-05-16T00:00:00Z",
    };
    mockedUseSearch.mockReturnValue({ results: [HIT], isSearching: false });
    useTreeStore.setState({
      searchQuery: "he",
      searchActive: false,
      searchResults: [],
    });

    renderWithProvider(<Sidebar />);
    await new Promise((r) => setTimeout(r, 20));
    expect(useTreeStore.getState().searchResults).toEqual([]);
    expect(useTreeStore.getState().searchActive).toBe(false);
  });
});

describe("<Sidebar /> — Phase 27 Plan 06: BookmarksPanel wiring", () => {
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
      sidebarPanel: "bookmarks",
      bookmarks: [],
      bookmarkFolders: [],
    });
  });

  it("renders <BookmarksPanel/> (bookmarks empty state), not the Plan 03 placeholder", () => {
    renderWithProvider(<Sidebar />);
    expect(screen.queryByTestId("bookmarks-panel-placeholder")).toBeNull();
    expect(screen.getByTestId("bookmarks-empty-state")).toBeDefined();
  });
});
