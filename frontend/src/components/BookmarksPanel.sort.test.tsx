/**
 * BookmarksPanel sorting tests.
 *
 * Kept in a separate file from BookmarksPanel.test.tsx because the sort
 * wiring needs TreeView stubbed: the assertions are about the node ORDER
 * and the drag props the panel hands down, not about rendered rows.
 * BookmarksSortMenu is stubbed too so a selection is a plain click rather
 * than a Radix pointer dance (the real menu has its own test file).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

const getBookmarksMock = vi.fn();
const postBookmarkMock = vi.fn();
const deleteBookmarkMock = vi.fn();
const postBookmarkMoveMock = vi.fn();
const postBookmarkFolderMock = vi.fn();
const reorderBookmarksMock = vi.fn();

vi.mock("../lib/bookmarksApi", async () => {
  const { createResource } = await import("../lib/resources/createResource");
  return {
    bookmarksResource: createResource("bookmarks", () => getBookmarksMock(), {
      mode: "cached",
      invalidatedBy: ["bookmark:changed"],
    }),
    postBookmark: (...args: unknown[]) => postBookmarkMock(...args),
    deleteBookmark: (...args: unknown[]) => deleteBookmarkMock(...args),
    postBookmarkMove: (...args: unknown[]) => postBookmarkMoveMock(...args),
    postBookmarkFolder: (...args: unknown[]) => postBookmarkFolderMock(...args),
    reorderBookmarks: (...args: unknown[]) => reorderBookmarksMock(...args),
  };
});

const getWorkspaceMock = vi.fn();
const putWorkspaceMock = vi.fn();

vi.mock("../lib/workspaceApi", async () => {
  const { createResource } = await import("../lib/resources/createResource");
  return {
    workspaceResource: createResource("workspace", () => getWorkspaceMock(), {
      mode: "cached",
      invalidatedBy: ["workspace:changed"],
    }),
    putWorkspace: (...args: unknown[]) => putWorkspaceMock(...args),
  };
});

const toastSpy = vi.fn();
vi.mock("./toast.utils", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

const mockUseFileTree = vi.fn();
vi.mock("../lib/useFileTree", () => ({
  useFileTree: () => mockUseFileTree(),
}));

interface CapturedTreeViewProps {
  data: Array<{ id: string; name: string; children?: unknown[] }>;
  disableDrag?: (node: unknown) => boolean;
  onMove?: unknown;
  onRootDrop?: unknown;
}
let treeViewProps: CapturedTreeViewProps | null = null;

vi.mock("./TreeView", () => ({
  TreeView: (props: CapturedTreeViewProps) => {
    treeViewProps = props;
    return (
      <div data-testid="treeview-stub">
        {props.data.map((n) => (
          <div key={n.id} data-testid="tv-row" data-node-id={n.id}>
            {n.name}
          </div>
        ))}
      </div>
    );
  },
}));

vi.mock("./BookmarksSortMenu", () => ({
  BookmarksSortMenu: ({
    value,
    onSelect,
  }: {
    value: string;
    onSelect: (v: string) => void;
  }) => (
    <div data-testid="sort-menu-stub" data-value={value}>
      <button type="button" onClick={() => onSelect("name-asc")}>
        pick-name-asc
      </button>
      <button type="button" onClick={() => onSelect("manual")}>
        pick-manual
      </button>
    </div>
  ),
}));

import { BookmarksPanel } from "./BookmarksPanel";
import { TooltipProvider } from "./Tooltip";
import { useTreeStore, BOOKMARKS_SORT_DEFAULT } from "../lib/useTreeStore";
import { usePaneStore } from "../lib/usePaneStore";
import { bookmarksResource } from "../lib/bookmarksApi";
import { workspaceResource } from "../lib/workspaceApi";
import type { Tree } from "../lib/treeApi";

const mockTree: Tree = {
  root: [
    {
      kind: "note",
      id: "note-a",
      path: "a.md",
      title: "Apple",
      updated_at: "2026-01-01T00:00:00Z",
      created: "2026-03-01T00:00:00Z",
    },
    {
      kind: "note",
      id: "note-z",
      path: "z.md",
      title: "Zebra",
      updated_at: "2026-01-05T00:00:00Z",
      created: "2026-03-05T00:00:00Z",
    },
  ],
} as unknown as Tree;

// Manual order deliberately reversed relative to alphabetical.
const bookmarks = [
  { id: "bm-z", note_id: "note-z", folder_id: null, order: 0 },
  { id: "bm-a", note_id: "note-a", folder_id: null, order: 1 },
];

async function renderPanel(ui: ReactElement) {
  const result = render(<TooltipProvider>{ui}</TooltipProvider>);
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

function rowNames(): string[] {
  return screen.getAllByTestId("tv-row").map((el) => el.textContent ?? "");
}

describe("BookmarksPanel — sorting", () => {
  beforeEach(() => {
    getBookmarksMock.mockReset().mockResolvedValue({ folders: [], bookmarks });
    postBookmarkMock.mockReset();
    deleteBookmarkMock.mockReset();
    postBookmarkMoveMock.mockReset();
    postBookmarkFolderMock.mockReset();
    reorderBookmarksMock.mockReset();
    getWorkspaceMock.mockReset().mockResolvedValue({});
    putWorkspaceMock.mockReset().mockResolvedValue({});
    toastSpy.mockReset();
    treeViewProps = null;
    bookmarksResource.clear();
    workspaceResource.clear();
    mockUseFileTree.mockReset().mockReturnValue({
      tree: mockTree,
      loading: false,
      error: null,
      refresh: vi.fn(),
      mutate: vi.fn(),
    });
    useTreeStore.setState({
      activeNoteId: null,
      bookmarksSort: BOOKMARKS_SORT_DEFAULT,
    });
    usePaneStore.setState({ openInActivePane: vi.fn() });
  });

  it("renders the sort control in the panel header", async () => {
    await renderPanel(<BookmarksPanel />);
    expect(screen.getByTestId("sort-menu-stub")).toBeDefined();
  });

  it("defaults to Manual, ordering rows by the persisted Order field", async () => {
    await renderPanel(<BookmarksPanel />);
    expect(screen.getByTestId("sort-menu-stub").dataset.value).toBe("manual");
    expect(rowNames()).toEqual(["Zebra", "Apple"]);
  });

  it("re-sorts on selection and PUTs the choice once, undebounced", async () => {
    await renderPanel(<BookmarksPanel />);

    await act(async () => {
      fireEvent.click(screen.getByText("pick-name-asc"));
    });

    expect(putWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(putWorkspaceMock).toHaveBeenCalledWith({ bookmarksSort: "name-asc" });
    await waitFor(() => expect(rowNames()).toEqual(["Apple", "Zebra"]));
  });

  it("reverts the order when the write fails", async () => {
    putWorkspaceMock.mockReset().mockRejectedValue(new Error("offline"));
    await renderPanel(<BookmarksPanel />);

    await act(async () => {
      fireEvent.click(screen.getByText("pick-name-asc"));
    });

    await waitFor(() => expect(rowNames()).toEqual(["Zebra", "Apple"]));
    expect(useTreeStore.getState().bookmarksSort).toBe("manual");
    expect(toastSpy).toHaveBeenCalled();
  });

  it("allows drag in Manual", async () => {
    await renderPanel(<BookmarksPanel />);
    expect(treeViewProps?.disableDrag?.({})).toBe(false);
    expect(treeViewProps?.onMove).toBeTypeOf("function");
    expect(treeViewProps?.onRootDrop).toBeTypeOf("function");
  });

  it("suppresses drag in every sorted order", async () => {
    useTreeStore.setState({ bookmarksSort: "modified-desc" });
    await renderPanel(<BookmarksPanel />);
    expect(treeViewProps?.disableDrag?.({})).toBe(true);
    expect(treeViewProps?.onMove).toBeUndefined();
    expect(treeViewProps?.onRootDrop).toBeUndefined();
  });
});
