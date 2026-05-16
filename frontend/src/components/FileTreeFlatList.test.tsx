/**
 * FileTree flat-list mode tests — Plan 06-08 Task 3 (FT1..FT7).
 *
 * These tests validate the activeTagFilter branch added to FileTree in
 * Phase 6. When activeTagFilter is non-null, FileTree fetches the flat
 * list of notes via tagsApi.listTagNotes and renders them as a simple
 * list (no arborist tree). When null, the normal tree renders.
 *
 * The tests intentionally DO NOT import from the enormous existing
 * FileTree.test.tsx to avoid merge conflicts with the wave 06-09 agent.
 * They are scoped to the flat-list branch only.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTreeStore } from "../lib/useTreeStore";
import { ToastProvider } from "./Toast";

// ────────────────────────────────────────────────────────────────────────────
// Module-level mocks (must be declared before any imports that use them)
// ────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/useFileTree", () => ({
  useFileTree: vi.fn(),
  broadcastRefresh: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../lib/notesApi", () => ({
  ScratchpadUUID: "00000000-0000-4000-a000-000000000001",
  getNote: vi.fn(),
  updateNote: vi.fn(),
}));

const listTagNotesMock = vi.fn();
vi.mock("../lib/tagsApi", () => ({
  listTags: vi.fn(),
  listTagNotes: (...args: unknown[]) => listTagNotesMock(...args),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
}));

// Mock useTagBrowser since TagBrowserSection (imported via Sidebar context) uses it
// but FileTree itself is standalone in these tests
vi.mock("../lib/useTagBrowser", () => ({
  useTagBrowser: vi.fn(() => ({
    tags: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

vi.mock("../lib/useTheme", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
  THEME_BOOTSTRAP_KEY: "jasper:theme-bootstrap",
}));

import { useFileTree } from "../lib/useFileTree";
import { useTreeMutations } from "../lib/useTreeMutations";
import { FileTree } from "./FileTree";

const mockedUseFileTree = vi.mocked(useFileTree);
const mockedUseTreeMutations = vi.mocked(useTreeMutations);

const noopRefresh = () => Promise.resolve();
const noopMutate = () => {};

function defaultMuts() {
  return {
    createNote: vi.fn(),
    deleteNote: vi.fn(),
    moveNote: vi.fn(),
    createFolder: vi.fn(),
    deleteFolder: vi.fn(),
    moveFolder: vi.fn(),
    // Plan 07-39 (UAT-5 N2-sub-B): internal file drag mutator.
    moveFile: vi.fn(),
  };
}

function defaultTree() {
  return {
    root: [
      {
        kind: "note" as const,
        id: "note-1",
        path: "first.md",
        title: "First Note",
        updated_at: new Date().toISOString(),
      },
      {
        kind: "note" as const,
        id: "note-2",
        path: "second.md",
        title: "Second Note",
        updated_at: new Date().toISOString(),
      },
    ],
  };
}

function renderFileTree(onSelectNote = vi.fn()) {
  return render(
    <ToastProvider>
      <FileTree onSelectNote={onSelectNote} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  useTreeStore.setState({
    expanded: new Set(),
    activeNoteId: null,
    pendingRename: null,
    draftCreate: null,
    activeTagFilter: null,
  });
  listTagNotesMock.mockReset();
  mockedUseFileTree.mockReset();
  mockedUseTreeMutations.mockReset();
  mockedUseTreeMutations.mockReturnValue(defaultMuts());
  mockedUseFileTree.mockReturnValue({
    tree: defaultTree(),
    loading: false,
    error: null,
    refresh: noopRefresh,
    mutate: noopMutate,
  });
});

describe("FileTree — flat-list mode (Phase 6 activeTagFilter branch)", () => {
  it("FT1: when activeTagFilter is null, FileTree behaves exactly as before (renders arborist tree)", async () => {
    useTreeStore.setState({ activeTagFilter: null });
    renderFileTree();

    // Normal tree renders — no flat list
    // ActiveTagFilterChip is not shown
    expect(screen.queryByRole("button", { name: /Remove tag filter/i })).toBeNull();

    // Tree renders (check that arborist is mounted by looking for the tree role)
    await waitFor(() => {
      expect(screen.getByRole("tree")).toBeInTheDocument();
    });
  });

  it("FT2: when activeTagFilter='foo', FileTree fetches via listTagNotes and renders a flat list", async () => {
    const flatNotes = [
      { id: "n1", path: "a.md", title: "Alpha Note", updated_at: new Date().toISOString() },
      { id: "n2", path: "b.md", title: "Beta Note", updated_at: new Date().toISOString() },
    ];
    listTagNotesMock.mockResolvedValue(flatNotes);
    useTreeStore.setState({ activeTagFilter: "foo" });

    renderFileTree();

    // Notes from flat list should appear
    await waitFor(() => {
      expect(screen.getByText("Alpha Note")).toBeInTheDocument();
      expect(screen.getByText("Beta Note")).toBeInTheDocument();
    });

    expect(listTagNotesMock).toHaveBeenCalledWith("foo");
  });

  it("FT3: active note highlight works in flat-list mode (active row has activeNoteId)", async () => {
    const flatNotes = [
      { id: "n1", path: "a.md", title: "Alpha Note", updated_at: new Date().toISOString() },
    ];
    listTagNotesMock.mockResolvedValue(flatNotes);
    useTreeStore.setState({ activeTagFilter: "foo", activeNoteId: "n1" });

    renderFileTree();

    await waitFor(() => {
      expect(screen.getByText("Alpha Note")).toBeInTheDocument();
    });

    // The active row should have data-active-note="true"
    const activeRow = document.querySelector('[data-active-note="true"]');
    expect(activeRow).toBeInTheDocument();
  });

  it("FT4: clicking a row in flat-list mode calls onSelectNote", async () => {
    const flatNotes = [
      { id: "n1", path: "a.md", title: "Alpha Note", updated_at: new Date().toISOString() },
    ];
    listTagNotesMock.mockResolvedValue(flatNotes);
    const onSelectNote = vi.fn();
    useTreeStore.setState({ activeTagFilter: "foo" });

    render(
      <ToastProvider>
        <FileTree onSelectNote={onSelectNote} />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("Alpha Note")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Alpha Note"));
    expect(onSelectNote).toHaveBeenCalledWith("n1");
  });

  it("FT6: ActiveTagFilterChip renders above the flat list when filter is active", async () => {
    listTagNotesMock.mockResolvedValue([]);
    useTreeStore.setState({ activeTagFilter: "mytag" });

    renderFileTree();

    await waitFor(() => {
      const chip = screen.getByRole("button", { name: "Remove tag filter: mytag" });
      expect(chip).toBeInTheDocument();
    });
  });

  it("FT7: empty flat list (tag has no carriers) renders an empty-state message", async () => {
    listTagNotesMock.mockResolvedValue([]);
    useTreeStore.setState({ activeTagFilter: "emptytag" });

    renderFileTree();

    await waitFor(() => {
      expect(screen.getByText(/No notes tagged/i)).toBeInTheDocument();
    });
  });
});
