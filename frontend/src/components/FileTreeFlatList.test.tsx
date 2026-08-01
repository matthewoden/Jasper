/**
 * FileTree flat-list mode tests — the activeTagFilter branch.
 *
 * When activeTagFilter is non-null, FileTree reads tagsApi.tagNotesResource
 * (keyed on tag name, D-10 single-slot) and renders a simple list (no
 * arborist tree). When null, the normal tree renders. Scoped to the
 * flat-list branch only. `tagNotesResource` is built with the REAL
 * `createKeyedResource` (not mocked) so the layer's fetch-once/subscribe
 * semantics are exercised for real — only the network-facing fetcher is
 * mocked.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTreeStore } from "../lib/useTreeStore";
import { ToastProvider } from "./Toast";
import { TooltipProvider } from "./Tooltip";


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
vi.mock("../lib/tagsApi", async () => {
  const { createKeyedResource } = await import("../lib/resources/createResource");
  return {
    listTags: vi.fn(),
    tagNotesResource: createKeyedResource(
      "tagNotes",
      (name: string) => listTagNotesMock(name),
      { mode: "cached", invalidatedBy: ["tags:updated", "tags:rewritten"] },
    ),
    renameTag: vi.fn(),
    deleteTag: vi.fn(),
  };
});


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
import { tagNotesResource } from "../lib/tagsApi";
import { FileTree } from "./FileTree";

const mockedUseFileTree = vi.mocked(useFileTree);
const mockedUseTreeMutations = vi.mocked(useTreeMutations);

const noopRefresh = () => Promise.resolve();

function defaultMuts() {
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
    <TooltipProvider>
      <ToastProvider>
        <FileTree onSelectNote={onSelectNote} />
      </ToastProvider>
    </TooltipProvider>,
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
  // tagNotesResource is a module-level singleton (D-10 single-slot); each
  // test reuses tag names like "foo" with different mocked data, so the
  // per-key cache must be cleared or a later test would read a prior
  // test's stale hydrated entry instead of refetching.
  tagNotesResource.clear();
  mockedUseFileTree.mockReset();
  mockedUseTreeMutations.mockReset();
  mockedUseTreeMutations.mockReturnValue(defaultMuts());
  mockedUseFileTree.mockReturnValue({
    tree: defaultTree(),
    loading: false,
    error: null,
    refresh: noopRefresh,
  });
});

describe("FileTree — flat-list mode (Phase 6 activeTagFilter branch)", () => {
  it("FT1: when activeTagFilter is null, FileTree behaves exactly as before (renders arborist tree)", async () => {
    useTreeStore.setState({ activeTagFilter: null });
    renderFileTree();

    expect(screen.queryByRole("button", { name: /Remove tag filter/i })).toBeNull();

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
      <TooltipProvider>
        <ToastProvider>
          <FileTree onSelectNote={onSelectNote} />
        </ToastProvider>
      </TooltipProvider>,
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
      const chip = screen.getByRole("button", { name: "Remove tag filter: #mytag" });
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
