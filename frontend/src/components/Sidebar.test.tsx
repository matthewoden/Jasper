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

import { useFileTree } from "../lib/useFileTree";
import { postAdminReindex } from "../lib/adminApi";
import { useTreeMutations } from "../lib/useTreeMutations";
import { useTreeStore, SIDEBAR_WIDTH_DEFAULT } from "../lib/useTreeStore";
import { Sidebar } from "./Sidebar";
import { ToastProvider } from "./Toast";

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

  it("TestSidebar_RendersToolbar — three buttons with the locked aria-labels", () => {
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
      screen.getByRole("button", { name: "Refresh" }),
    ).toBeInTheDocument();
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

  it("TestSidebar_RefreshTriggersIncrementalReindex", async () => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    mockedPostAdminReindex.mockResolvedValue({
      data: { started_at: "2026-01-01T00:00:00Z", notes_indexed: 0 },
      error: undefined,
      response: new Response(),
    });
    renderWithProvider(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(mockedPostAdminReindex).toHaveBeenCalledWith("incremental");
    });
  });

  it("TestSidebar_RefreshAlsoTriggersUseFileTreeRefresh — order: postAdminReindex then refresh", async () => {
    const order: string[] = [];
    const refresh = vi.fn(async () => {
      order.push("refresh");
    });
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh,
      mutate: noopMutate,
    });
    mockedPostAdminReindex.mockImplementation(async () => {
      order.push("postAdminReindex");
      return {
        data: { started_at: "2026-01-01T00:00:00Z", notes_indexed: 0 },
        error: undefined,
        response: new Response(),
      };
    });
    renderWithProvider(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
    expect(order).toEqual(["postAdminReindex", "refresh"]);
  });

  it("TestSidebar_RefreshError_StopsSpinAndDoesNotCallRefresh", async () => {
    const refresh = vi.fn(async () => {});
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh,
      mutate: noopMutate,
    });
    mockedPostAdminReindex.mockResolvedValue({
      data: undefined,
      error: { code: "internal", message: "boom" },
      response: new Response(),
    });
    renderWithProvider(<Sidebar />);
    const btn = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(btn).not.toBeDisabled();
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("TestSidebar_RefreshError_SurfacesToast — Plan 03-07 locked tuple", async () => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    mockedPostAdminReindex.mockResolvedValue({
      data: undefined,
      error: { code: "internal", message: "db locked" },
      response: new Response(),
    });
    renderWithProvider(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(
        screen.getByText("Couldn't refresh the index."),
      ).toBeInTheDocument();
    });
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
