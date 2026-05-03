/**
 * App-shell tests — Phase 2 composition. Phase 1's three-column grid is now
 * nested inside a flex column with the migration banner row above. We mock
 * the admin status hook so each test can drive the migration-banner branch
 * without spinning up real fetch.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("./lib/notesApi", () => ({
  ScratchpadUUID: "00000000-0000-4000-a000-000000000001",
  getNote: vi.fn().mockResolvedValue({
    data: {
      id: "00000000-0000-4000-a000-000000000001",
      path: "scratchpad.md",
      content: "# Welcome",
      updated_at: "2025-01-01T00:00:00Z",
    },
    error: undefined,
    response: new Response(),
  }),
  updateNote: vi.fn(),
}));

const getAdminStatusMock = vi.fn();
const postAdminReindexMock = vi.fn();

vi.mock("./lib/adminApi", () => ({
  getAdminStatus: (...args: unknown[]) => getAdminStatusMock(...args),
  postAdminReindex: (...args: unknown[]) => postAdminReindexMock(...args),
}));

// Phase 3 — Sidebar consumes useFileTree (which calls GET /tree on
// mount). Mock it here so the App-shell tests don't trigger a real
// fetch. An empty tree keeps the sidebar's <FileTree> in its empty-state
// branch, which has no role="alert" and won't collide with the
// migration banner's role="alert" in tests A3 and A5.
vi.mock("./lib/useFileTree", () => ({
  useFileTree: () => ({
    tree: { root: [] },
    loading: false,
    error: null,
    refresh: () => Promise.resolve(),
    mutate: () => {},
  }),
}));

import App from "./App";

describe("<App /> — Phase 2 shell composition", () => {
  beforeEach(() => {
    getAdminStatusMock.mockReset();
    postAdminReindexMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("A1: when status=ok, the locked three-column grid still renders inside the flex column", async () => {
    getAdminStatusMock.mockResolvedValue({
      data: { state: "ok", notes_indexed: 0 },
      error: undefined,
    });

    const { container } = render(<App />);
    const root = container.firstChild as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.style.display).toBe("flex");
    expect(root.style.flexDirection).toBe("column");
    expect(root.style.minHeight).toBe("100vh");

    // The three-column grid is now an inner div under the flex column
    // (the banner is a sibling but renders nothing when state=ok).
    const grid = root.querySelector(
      'div[style*="grid-template-columns"]',
    ) as HTMLElement | null;
    expect(grid).not.toBeNull();
    expect(grid!.style.gridTemplateColumns).toBe("260px 1fr 0");

    // Sidebar + BacklinksColumn anchors still mount.
    expect(screen.getByText("NOTES")).toBeInTheDocument();
    // Phase 3: the static Phase 1 "scratchpad" hardcoded sidebar row is
    // gone. With the mocked-empty tree we expect the FileTree empty
    // state to render in its place.
    expect(screen.getByTestId("tree-empty-state")).toBeInTheDocument();
    const aside = document.querySelector("aside[aria-hidden]");
    expect(aside).not.toBeNull();
  });

  it("A2: status=ok renders no banner and the editor textarea is enabled", async () => {
    getAdminStatusMock.mockResolvedValue({
      data: { state: "ok" },
      error: undefined,
    });

    render(<App />);
    expect(screen.queryByRole("alert")).toBeNull();
    const textarea = screen.getByLabelText(
      "Scratchpad note content",
    ) as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    await waitFor(() => expect(textarea).not.toBeDisabled());
  });

  it("A3: status=rolled_back renders the migration banner with locked copy + Reset button", async () => {
    getAdminStatusMock.mockResolvedValue({
      data: {
        state: "rolled_back",
        failed_migration: "003_tags.sql",
        logs_path: "/tmp/jasper.log",
      },
      error: undefined,
    });

    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("Migration 003_tags.sql failed."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reset and rebuild database" }),
    ).toBeInTheDocument();
  });

  it("A4: clicking Reset → Confirm fires postAdminReindex and the success path mounts/unmounts ReindexProgress", async () => {
    getAdminStatusMock.mockResolvedValue({
      data: {
        state: "rolled_back",
        failed_migration: "003.sql",
        logs_path: "/tmp/log",
      },
      error: undefined,
    });
    postAdminReindexMock.mockResolvedValue({
      data: { started_at: "2025-01-01T00:00:00Z", notes_indexed: 7 },
      error: undefined,
    });

    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reset and rebuild database" }),
      ).toBeInTheDocument(),
    );

    // Click Reset → opens dialog.
    fireEvent.click(
      screen.getByRole("button", { name: "Reset and rebuild database" }),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    // Click Confirm → dialog closes, POST fires, overlay mounts.
    fireEvent.click(
      screen.getByRole("button", { name: "Reset and rebuild" }),
    );

    await waitFor(() =>
      expect(screen.getByText("Index rebuilt.")).toBeInTheDocument(),
    );
    expect(postAdminReindexMock).toHaveBeenCalledWith("full");

    // Subsequent status refresh — server now reports ok.
    getAdminStatusMock.mockResolvedValueOnce({
      data: { state: "ok" },
      error: undefined,
    });

    // Wait for the parent's 600ms transient → overlay unmounts.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(screen.queryByText("Index rebuilt.")).toBeNull();
  });

  it("A5: postAdminReindex error → ReindexProgress shows error copy; Close returns to the editor", async () => {
    getAdminStatusMock.mockResolvedValue({
      data: {
        state: "rolled_back",
        failed_migration: "003.sql",
        logs_path: "/tmp/log",
      },
      error: undefined,
    });
    postAdminReindexMock.mockResolvedValue({
      data: undefined,
      error: { code: "unrecoverable", message: "db is busy" },
    });

    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Reset and rebuild database" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reset and rebuild" }),
    );

    await waitFor(() =>
      expect(
        screen.getByText(/Couldn.t rebuild the index/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("db is busy")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(
        screen.queryByText(/Couldn.t rebuild the index/),
      ).toBeNull(),
    );
  });

  it("A6: Toast viewport is rendered exactly once (UI-SPEC §Forward-Compat assert #3)", () => {
    getAdminStatusMock.mockResolvedValue({
      data: { state: "ok" },
      error: undefined,
    });
    render(<App />);
    // Radix Toast.Viewport renders as a wrapper div with
    // role="region" aria-label="Notifications (F8)". Asserting count==1
    // proves the provider is mounted exactly once at the App root.
    const viewports = document.querySelectorAll(
      'div[role="region"][aria-label^="Notifications"]',
    );
    expect(viewports.length).toBe(1);
  });
});
