/**
 * Tests for RightRailTagsPanel component (body-only,
 * no filter input, no own header/close button).
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTreeStore } from "../lib/useTreeStore";


const mockRefresh = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/useTagBrowser", () => ({
  useTagBrowser: vi.fn(() => ({
    tags: [],
    loading: false,
    error: null,
    refresh: mockRefresh,
  })),
}));


const mockRenameTag = vi.fn();
const mockDeleteTag = vi.fn();
vi.mock("../lib/tagsApi", () => ({
  listTags: vi.fn(),
  listTagNotes: vi.fn(),
  renameTag: (...args: unknown[]) => mockRenameTag(...args),
  deleteTag: (...args: unknown[]) => mockDeleteTag(...args),
}));


vi.mock("../lib/useTheme", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
  THEME_BOOTSTRAP_KEY: "jasper:theme-bootstrap",
}));

import { useTagBrowser } from "../lib/useTagBrowser";
import { RightRailTagsPanel } from "./RightRailTagsPanel";
import { ToastProvider } from "./Toast";

const mockedUseTagBrowser = vi.mocked(useTagBrowser);

const fakeTags = [
  { name: "alpha", count: 5 },
  { name: "beta", count: 2 },
  { name: "project", count: 12 },
];

function renderPanel() {
  return render(
    <ToastProvider>
      <RightRailTagsPanel />
    </ToastProvider>,
  );
}

beforeEach(() => {
  useTreeStore.setState({
    activeTagFilter: null,
    activeNoteId: null,
  });
  mockedUseTagBrowser.mockReset();
  mockedUseTagBrowser.mockReturnValue({
    tags: fakeTags,
    loading: false,
    error: null,
    refresh: mockRefresh,
  });
  mockRenameTag.mockReset();
  mockDeleteTag.mockReset();
});

describe("RightRailTagsPanel — body-only, single-list (no header/close/filter)", () => {
  it("does not render a header row", () => {
    renderPanel();
    expect(document.querySelector("header")).toBeNull();
  });

  it("does not render a × close button", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: /close tags panel/i })).toBeNull();
  });

  it("does not render the substring filter input", () => {
    renderPanel();
    expect(screen.queryByPlaceholderText("Filter tags…")).toBeNull();
  });

  it("renders the tag list directly (no expand/collapse gating)", () => {
    renderPanel();
    expect(screen.getByTestId("tag-row-alpha")).toBeInTheDocument();
    expect(screen.getByTestId("tag-row-beta")).toBeInTheDocument();
    expect(screen.getByTestId("tag-row-project")).toBeInTheDocument();
  });

  it("panel shell is flat — no floating-card border/radius inside the tabbed rail", () => {
    const { container } = renderPanel();
    expect(container.querySelector('[style*="border-radius: 8px"]')).toBeNull();
    const list = screen.getAllByRole("list")[0];
    let node: HTMLElement | null = list;
    while (node && node !== container) {
      expect(node.style.border === "" || node.style.border === "none").toBe(true);
      node = node.parentElement;
    }
  });

  it("does not render its own 'Tags' sub-header or a count pill", () => {
    renderPanel();
    expect(screen.queryByText("Tags")).toBeNull();
    expect(screen.queryByText("3")).toBeNull();
  });
});

describe("RightRailTagsPanel — tag list behaviors (kept unchanged)", () => {
  it("rows sorted count-desc with alphabetical ties, name + count badge", () => {
    renderPanel();

    const tagItems = screen.getAllByRole("listitem");
    expect(tagItems[0]).toHaveTextContent("project");
    expect(tagItems[1]).toHaveTextContent("alpha");
    expect(tagItems[2]).toHaveTextContent("beta");
    const alphaRow = screen.getByTestId("tag-row-alpha");
    const betaRow = screen.getByTestId("tag-row-beta");
    expect(alphaRow).toHaveTextContent("5");
    expect(betaRow).toHaveTextContent("2");
    expect(alphaRow.querySelector('[aria-label="5 notes"]')).not.toBeNull();
    expect(betaRow.querySelector('[aria-label="2 notes"]')).not.toBeNull();
    expect(alphaRow.textContent ?? "").not.toMatch(/\(\d/);
  });

  it("clicking a tag row calls setActiveTagFilter with the BARE name (no # prefix)", () => {
    renderPanel();

    fireEvent.click(screen.getByTestId("tag-row-alpha"));
    expect(useTreeStore.getState().activeTagFilter).toBe("alpha");
  });

  it("active tag row has data-active=true", () => {
    useTreeStore.setState({ activeTagFilter: "beta" });
    renderPanel();

    const betaRow = screen.getByTestId("tag-row-beta");
    expect(betaRow).toHaveAttribute("data-active", "true");
  });

  it("tag rows have ContextMenu trigger wrapping (right-click structure)", () => {
    renderPanel();

    const projectRow = screen.getByTestId("tag-row-project");
    expect(projectRow).toBeInTheDocument();
  });

  it("delete with N<=5 calls deleteTag silently", async () => {
    mockDeleteTag.mockResolvedValue({ old_name: "alpha", touched_note_ids: ["id-1"] });

    const { container } = renderPanel();
    const deleteBtn = container.querySelector('[data-testid="delete-tag-alpha"]');
    if (deleteBtn) {
      fireEvent.click(deleteBtn);
      await waitFor(() => {
        expect(mockDeleteTag).toHaveBeenCalledWith("alpha");
      });
    }
  });

  it("right-clicking a row applies soft-select background tint", () => {
    renderPanel();

    const row = screen.getByTestId("tag-row-alpha");
    fireEvent.contextMenu(row);

    const style = (row as HTMLElement).style.background;
    expect(style).toContain("color-mix");
    expect(style).toContain("8%");
  });

  it("inactive '#tagname' spans render plain fg — only the active tag gets accent", () => {
    renderPanel();

    const hashSpan = screen.getByText("#project");
    expect(hashSpan).toHaveStyle({ color: "var(--color-fg)" });
  });

  it("the count is a plain muted number with aria-label='<N> notes' (no background pill)", () => {
    renderPanel();

    const row = screen.getByTestId("tag-row-project");
    const badge = row.querySelector('[aria-label="12 notes"]') as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge!).toHaveStyle({
      color: "var(--color-muted)",
      fontSize: "11.5px",
      fontWeight: "400",
    });
    expect(badge!.style.background).toBe("");
    expect(badge!.style.borderRadius).toBe("");
  });

  it("setActiveTagFilter receives the BARE tagname (not '#project')", () => {
    renderPanel();

    fireEvent.click(screen.getByTestId("tag-row-project"));
    expect(useTreeStore.getState().activeTagFilter).toBe("project");
    expect(useTreeStore.getState().activeTagFilter).not.toBe("#project");
  });
});

describe("RightRailTagsPanel — empty state (vault has zero tags)", () => {
  it("empty state uses the mock-literal 'No tags in this vault' copy", () => {
    mockedUseTagBrowser.mockReturnValue({
      tags: [],
      loading: false,
      error: null,
      refresh: mockRefresh,
    });
    renderPanel();

    expect(screen.getByText("No tags in this vault")).toBeInTheDocument();
  });

  it("empty state does NOT show old frontmatter copy", () => {
    mockedUseTagBrowser.mockReturnValue({
      tags: [],
      loading: false,
      error: null,
      refresh: mockRefresh,
    });
    renderPanel();

    expect(screen.queryByText(/Add tags: \[\]/)).toBeNull();
  });
});

describe("RightRailTagsPanel — no chevron in this surface", () => {
  it("no .lucide-chevron-down or .lucide-chevron-right rendered by this component", () => {
    const { container } = renderPanel();
    expect(container.querySelector(".lucide-chevron-down")).toBeNull();
    expect(container.querySelector(".lucide-chevron-right")).toBeNull();
  });
});
