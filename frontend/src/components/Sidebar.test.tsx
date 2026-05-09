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

  it("TestSidebar_FixedWidth260", () => {
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
});
