/**
 * Sidebar tests — Phase 3 chassis.
 *
 * The Phase 1 hardcoded single-scratchpad-row stub is GONE: the new
 * sidebar mounts SidebarToolbar in the header + FileTree below. The
 * FileTree consumes useFileTree (hook); we mock it here to control the
 * tree state per test.
 *
 * The Refresh button (in SidebarToolbar) calls postAdminReindex("incremental")
 * via Sidebar's own onRefresh wrapper, then re-fetches the tree via
 * useFileTree.refresh(). Phase 2's reindex banner / progress overlay are
 * App-shell concerns — Sidebar does NOT mount them.
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

import { useFileTree } from "../lib/useFileTree";
import { postAdminReindex } from "../lib/adminApi";
import { Sidebar } from "./Sidebar";

const mockedUseFileTree = vi.mocked(useFileTree);
const mockedPostAdminReindex = vi.mocked(postAdminReindex);

const noopMutate = () => {};

beforeEach(() => {
  mockedUseFileTree.mockReset();
  mockedPostAdminReindex.mockReset();
});

afterEach(() => {
  mockedUseFileTree.mockReset();
  mockedPostAdminReindex.mockReset();
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
    render(<Sidebar />);
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
    render(<Sidebar />);
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
    render(<Sidebar />);
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
    render(<Sidebar />);
    const nav = screen.getByLabelText("Notes navigation") as HTMLElement;
    expect(nav.style.width).toBe("260px");
  });

  it("TestSidebar_NoStaticScratchpadRow — Phase 1 hardcoded row is gone", () => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] }, // empty tree → empty state, no row should mention scratchpad
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    render(<Sidebar />);
    // The literal text "scratchpad" must NOT appear when the tree is
    // empty — Phase 1's hardcoded row is gone.
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
    render(<Sidebar />);
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
    render(<Sidebar />);
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
    render(<Sidebar />);
    const btn = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(btn);
    // The toolbar's catch handler clears the spin-disabled treatment.
    await waitFor(() => {
      expect(btn).not.toBeDisabled();
    });
    // Refresh from useFileTree should NOT have been called because the
    // POST errored out — the wrapper threw before reaching refresh.
    expect(refresh).not.toHaveBeenCalled();
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
    render(<Sidebar />);
    await waitFor(() => {
      expect(screen.getByText("Scratchpad")).toBeInTheDocument();
    });
  });

  it("TestSidebar_NewNoteAndNewFolder_Click — buttons render and click without crashing (handlers are 03-07 stubs)", () => {
    mockedUseFileTree.mockReturnValue({
      tree: { root: [] },
      loading: false,
      error: null,
      refresh: () => Promise.resolve(),
      mutate: noopMutate,
    });
    render(<Sidebar />);
    // Should not throw — handlers are intentional no-ops in 03-06.
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
  });
});
