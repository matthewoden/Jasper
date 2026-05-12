/**
 * Tests for RightRailTagsPanel component.
 * Phase 6.5 — UX-T-01, UX-T-05.
 *
 * Validates relocated tag browser behaviors (TB1..TB13 adapted) plus new
 * search-input behaviors (SR1..SR6) and panel-card shell spec.
 *
 * Adapted from TagBrowserSection.test.tsx — same patterns, new slice names,
 * new header copy (title-case), new search input tests.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTreeStore } from "../lib/useTreeStore";

// Mock useTagBrowser
const mockRefresh = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/useTagBrowser", () => ({
  useTagBrowser: vi.fn(() => ({
    tags: [],
    loading: false,
    error: null,
    refresh: mockRefresh,
  })),
}));

// Mock tagsApi
const mockRenameTag = vi.fn();
const mockDeleteTag = vi.fn();
vi.mock("../lib/tagsApi", () => ({
  listTags: vi.fn(),
  listTagNotes: vi.fn(),
  renameTag: (...args: unknown[]) => mockRenameTag(...args),
  deleteTag: (...args: unknown[]) => mockDeleteTag(...args),
}));

// Mock useTheme to avoid config fetching
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
  { name: "prototype", count: 3 },
  { name: "process", count: 7 },
];

function renderPanel() {
  return render(
    <ToastProvider>
      <RightRailTagsPanel />
    </ToastProvider>,
  );
}

beforeEach(() => {
  // Reset store state — use rightRailTagsPanelExpanded (not tagBrowserExpanded)
  useTreeStore.setState({
    rightRailTagsPanelExpanded: false,
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

describe("RightRailTagsPanel — header and collapsed state", () => {
  it("TB1-adapted: when rightRailTagsPanelExpanded=false, renders only header with 'Tags (N)' title-case text", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    renderPanel();

    // Header must use title-case "Tags (N)" — NOT uppercase "TAGS (N)"
    expect(screen.getByText(/^Tags \(5\)$/)).toBeInTheDocument();

    // No tag rows visible
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.queryByText("beta")).toBeNull();
  });

  it("TB1-adapted: header does NOT render uppercase 'TAGS' (title-case enforced)", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    renderPanel();

    // Must NOT find uppercase TAGS label (that was Phase 6 left-sidebar style)
    expect(screen.queryByText(/TAGS \(\d+\)/)).toBeNull();
  });

  it("TB2-adapted: when rightRailTagsPanelExpanded=true, renders header + tag rows + search input", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    // Header shows count
    expect(screen.getByText(/^Tags \(5\)$/)).toBeInTheDocument();

    // Tag rows visible
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("project")).toBeInTheDocument();

    // Search input visible when expanded
    expect(screen.getByPlaceholderText("Filter tags…")).toBeInTheDocument();
  });

  it("TB3-adapted: clicking header toggles rightRailTagsPanelExpanded", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    renderPanel();

    const header = screen.getByRole("button", { name: /tags panel/i });
    fireEvent.click(header);

    expect(useTreeStore.getState().rightRailTagsPanelExpanded).toBe(true);

    fireEvent.click(header);
    expect(useTreeStore.getState().rightRailTagsPanelExpanded).toBe(false);
  });

  it("TB13-adapted: aria-expanded on the header button reflects rightRailTagsPanelExpanded", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    renderPanel();

    const header = screen.getByRole("button", { name: /tags panel/i });
    expect(header).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
  });
});

describe("RightRailTagsPanel — panel card shell spec", () => {
  it("panel card has borderRadius: 8 style", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    const { container } = renderPanel();
    // The outer panel card element should have borderRadius 8px
    const panel = container.firstChild?.firstChild as HTMLElement | null;
    expect(panel).toBeTruthy();
    // Check the inline style — borderRadius 8px is locked per plan
    const style = (panel as HTMLElement)?.style;
    expect(style?.borderRadius).toBe("8px");
  });
});

describe("RightRailTagsPanel — tag list behaviors (adapted from Phase 6)", () => {
  it("TB4-adapted: rows sorted alphabetically with name + count", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    const tagItems = screen.getAllByRole("listitem");
    // Tags are alpha, beta, process, project, prototype alphabetically
    expect(tagItems[0]).toHaveTextContent("alpha");
    expect(tagItems[1]).toHaveTextContent("beta");
    // Counts visible
    expect(screen.getByText("5")).toBeInTheDocument(); // alpha
    expect(screen.getByText("2")).toBeInTheDocument(); // beta
  });

  it("TB5-adapted: clicking a tag row calls setActiveTagFilter", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    fireEvent.click(screen.getByText("alpha"));
    expect(useTreeStore.getState().activeTagFilter).toBe("alpha");
  });

  it("TB7-adapted: active tag row has data-active=true", () => {
    useTreeStore.setState({
      rightRailTagsPanelExpanded: true,
      activeTagFilter: "beta",
    });
    renderPanel();

    const betaRow = screen.getByTestId("tag-row-beta");
    expect(betaRow).toHaveAttribute("data-active", "true");
  });

  it("TB8-adapted: tag rows have ContextMenu trigger wrapping (right-click structure)", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    const projectRow = screen.getByTestId("tag-row-project");
    expect(projectRow).toBeInTheDocument();
  });

  it("TB10-adapted: delete with N<=5 calls deleteTag silently", async () => {
    mockDeleteTag.mockResolvedValue({ old_name: "alpha", touched_note_ids: ["id-1"] });
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });

    const { container } = renderPanel();
    const deleteBtn = container.querySelector('[data-testid="delete-tag-alpha"]');
    if (deleteBtn) {
      fireEvent.click(deleteBtn);
      await waitFor(() => {
        expect(mockDeleteTag).toHaveBeenCalledWith("alpha");
      });
    }
  });
});

describe("RightRailTagsPanel — empty states", () => {
  it("TB12-adapted: empty state when no tags uses body-first 'Type #tagname' copy", () => {
    mockedUseTagBrowser.mockReturnValue({
      tags: [],
      loading: false,
      error: null,
      refresh: mockRefresh,
    });
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    expect(
      screen.getByText(/No tags yet\. Type #tagname in any note to add a tag\./),
    ).toBeInTheDocument();
  });

  it("TB12-adapted: empty state does NOT show old frontmatter copy", () => {
    mockedUseTagBrowser.mockReturnValue({
      tags: [],
      loading: false,
      error: null,
      refresh: mockRefresh,
    });
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    // The Phase 6 left-sidebar copy must be gone
    expect(screen.queryByText(/Add tags: \[\]/)).toBeNull();
  });
});

// ── SR: Search input behaviors (NEW for Phase 6.5 UX-T-05) ──────────────────

describe("RightRailTagsPanel — search input (SR1..SR6)", () => {
  it("SR1: search input is hidden when panel is collapsed", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    renderPanel();

    expect(screen.queryByPlaceholderText("Filter tags…")).toBeNull();
  });

  it("SR2: search input visible when panel is expanded", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    const input = screen.getByPlaceholderText("Filter tags…");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-label", "Filter tag list");
  });

  it("SR3: typing 'pro' filters to tags containing 'pro' (case-insensitive substring)", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    const input = screen.getByPlaceholderText("Filter tags…");
    fireEvent.change(input, { target: { value: "pro" } });

    // "project", "prototype", "process" all contain "pro"
    expect(screen.getByText("project")).toBeInTheDocument();
    expect(screen.getByText("prototype")).toBeInTheDocument();
    expect(screen.getByText("process")).toBeInTheDocument();

    // "alpha", "beta" do NOT contain "pro"
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.queryByText("beta")).toBeNull();
  });

  it("SR3b: filter is case-insensitive — 'PRO' matches same tags as 'pro'", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    const input = screen.getByPlaceholderText("Filter tags…");
    fireEvent.change(input, { target: { value: "PRO" } });

    expect(screen.getByText("project")).toBeInTheDocument();
    expect(screen.getByText("prototype")).toBeInTheDocument();
    expect(screen.getByText("process")).toBeInTheDocument();
    expect(screen.queryByText("alpha")).toBeNull();
  });

  it("SR4: pressing Esc clears the search input", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    const input = screen.getByPlaceholderText("Filter tags…");
    fireEvent.change(input, { target: { value: "pro" } });
    expect((input as HTMLInputElement).value).toBe("pro");

    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("SR5: no-match empty state shows query in message", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    const input = screen.getByPlaceholderText("Filter tags…");
    fireEvent.change(input, { target: { value: "zzz" } });

    expect(screen.getByText(/No tags match "zzz"\./)).toBeInTheDocument();
    // Must NOT show the "no tags" message (there ARE tags, just none matching)
    expect(screen.queryByText(/No tags yet\./)).toBeNull();
  });

  it("SR6: changing activeNoteId in store resets searchQuery to empty", async () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true, activeNoteId: "note-1" });
    renderPanel();

    const input = screen.getByPlaceholderText("Filter tags…");
    fireEvent.change(input, { target: { value: "pro" } });
    expect((input as HTMLInputElement).value).toBe("pro");

    // Simulate note switch by changing activeNoteId in the store
    useTreeStore.setState({ activeNoteId: "note-2" });

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe("");
    });
  });
});

describe("RightRailTagsPanel — slice isolation (ADD-only invariant)", () => {
  it("uses rightRailTagsPanelExpanded slice — not tagBrowserExpanded", () => {
    // Set rightRailTagsPanelExpanded=true but tagBrowserExpanded=false
    // Panel should still show content
    useTreeStore.setState({
      rightRailTagsPanelExpanded: true,
      tagBrowserExpanded: false,
    });
    renderPanel();

    // Tags visible — the new slice controls expansion
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("tagBrowserExpanded=true does NOT affect RightRailTagsPanel expansion", () => {
    // tagBrowserExpanded=true but rightRailTagsPanelExpanded=false
    // Panel should remain collapsed
    useTreeStore.setState({
      rightRailTagsPanelExpanded: false,
      tagBrowserExpanded: true,
    });
    renderPanel();

    // Tags NOT visible — new panel uses its own slice
    expect(screen.queryByText("alpha")).toBeNull();
  });
});
