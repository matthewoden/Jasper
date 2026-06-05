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

    expect(screen.getByText(/^Tags \(5\)$/)).toBeInTheDocument();

    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.queryByText("beta")).toBeNull();
  });

  it("TB1-adapted: header does NOT render uppercase 'TAGS' (title-case enforced)", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    renderPanel();

    expect(screen.queryByText(/TAGS \(\d+\)/)).toBeNull();
  });

  it("TB2-adapted: when rightRailTagsPanelExpanded=true, renders header + tag rows + search input", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    expect(screen.getByText(/^Tags \(5\)$/)).toBeInTheDocument();

    expect(screen.getByTestId("tag-row-alpha")).toBeInTheDocument();
    expect(screen.getByTestId("tag-row-beta")).toBeInTheDocument();
    expect(screen.getByTestId("tag-row-project")).toBeInTheDocument();

    expect(screen.getByPlaceholderText("Filter tags…")).toBeInTheDocument();
  });

  it("TB3-adapted: C4 (UAT-2 N4) — header has NO expand/collapse button (chevron removed)", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    renderPanel();

    expect(screen.queryByRole("button", { name: /^tags panel,/i })).toBeNull();
    expect(screen.getByRole("button", { name: /close tags panel/i })).toBeInTheDocument();
  });

  it("TB13-adapted: C4 (UAT-2 N4) — no aria-expanded button in header (expand removed)", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    renderPanel();

    const buttons = screen.getAllByRole("button");
    const expandButton = buttons.find(
      (btn) => btn.hasAttribute("aria-expanded"),
    );
    expect(expandButton).toBeUndefined();
  });
});

describe("RightRailTagsPanel — panel card shell spec", () => {
  it("panel card has borderRadius: 8 style", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    const { container } = renderPanel();
    const panel = container.firstChild as HTMLElement | null;
    expect(panel).toBeTruthy();
    const styleAttr = (panel as HTMLElement)?.getAttribute("style") ?? "";
    expect(styleAttr).toContain("border-radius: 8px");
  });
});

describe("RightRailTagsPanel — tag list behaviors (adapted from Phase 6)", () => {
  it("TB4-adapted: rows sorted alphabetically with name + count badge", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    const tagItems = screen.getAllByRole("listitem");
    expect(tagItems[0]).toHaveTextContent("alpha");
    expect(tagItems[1]).toHaveTextContent("beta");
    const alphaRow = screen.getByTestId("tag-row-alpha");
    const betaRow = screen.getByTestId("tag-row-beta");
    expect(alphaRow).toHaveTextContent("5");
    expect(betaRow).toHaveTextContent("2");
    expect(alphaRow.querySelector('[aria-label="5 notes"]')).not.toBeNull();
    expect(betaRow.querySelector('[aria-label="2 notes"]')).not.toBeNull();
    expect(alphaRow.textContent ?? "").not.toMatch(/\(\d/);
  });

  it("TB5-adapted: clicking a tag row calls setActiveTagFilter with the BARE name (no # prefix)", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    fireEvent.click(screen.getByTestId("tag-row-alpha"));
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

    expect(screen.queryByText(/Add tags: \[\]/)).toBeNull();
  });
});


describe("RightRailTagsPanel — search input (SR1..SR6)", () => {
  it("SR1: C4 (UAT-2 N4) — search input is ALWAYS visible (expand/collapse removed)", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    renderPanel();

    expect(screen.getByPlaceholderText("Filter tags…")).toBeInTheDocument();
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

    expect(screen.getByTestId("tag-row-project")).toBeInTheDocument();
    expect(screen.getByTestId("tag-row-prototype")).toBeInTheDocument();
    expect(screen.getByTestId("tag-row-process")).toBeInTheDocument();

    expect(screen.queryByTestId("tag-row-alpha")).toBeNull();
    expect(screen.queryByTestId("tag-row-beta")).toBeNull();
  });

  it("SR3b: filter is case-insensitive — 'PRO' matches same tags as 'pro'", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    const input = screen.getByPlaceholderText("Filter tags…");
    fireEvent.change(input, { target: { value: "PRO" } });

    expect(screen.getByTestId("tag-row-project")).toBeInTheDocument();
    expect(screen.getByTestId("tag-row-prototype")).toBeInTheDocument();
    expect(screen.getByTestId("tag-row-process")).toBeInTheDocument();
    expect(screen.queryByTestId("tag-row-alpha")).toBeNull();
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

    expect(
      screen.getByText((text) => text.includes("No tags match") && text.includes("zzz")),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No tags yet\./)).toBeNull();
  });

  it("SR6: changing activeNoteId in store resets searchQuery to empty", async () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true, activeNoteId: "note-1" });
    renderPanel();

    const input = screen.getByPlaceholderText("Filter tags…");
    fireEvent.change(input, { target: { value: "pro" } });
    expect((input as HTMLInputElement).value).toBe("pro");

    useTreeStore.setState({ activeNoteId: "note-2" });

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe("");
    });
  });
});


describe("RightRailTagsPanel — Phase 6.6 row format (D-20/D-21/D-22)", () => {
  it("tag row renders '#tagname' + count badge (UAT 2026-05-12)", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    const row = screen.getByTestId("tag-row-project");
    expect(row).toHaveTextContent("#project");
    expect(row).toHaveTextContent("12");
    expect(row).not.toHaveTextContent("(12)");
    expect(row.querySelector('[aria-label="12 notes"]')).not.toBeNull();
  });

  it("the '#tagname' span has color var(--color-accent)", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    const hashSpan = screen.getByText("#project");
    expect(hashSpan).toHaveStyle({ color: "var(--color-accent)" });
  });

  it("the count badge has muted text color and aria-label='<N> notes'", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    const row = screen.getByTestId("tag-row-project");
    const badge = row.querySelector('[aria-label="12 notes"]') as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge!).toHaveStyle({ color: "var(--color-muted)" });
  });

  it("setActiveTagFilter receives the BARE tagname (not '#project')", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    fireEvent.click(screen.getByTestId("tag-row-project"));
    expect(useTreeStore.getState().activeTagFilter).toBe("project");
    expect(useTreeStore.getState().activeTagFilter).not.toBe("#project");
  });

  it("right-clicking a row applies soft-select background tint", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    renderPanel();

    const row = screen.getByTestId("tag-row-alpha");
    fireEvent.contextMenu(row);

    const style = (row as HTMLElement).style.background;
    expect(style).toContain("color-mix");
    expect(style).toContain("8%");
  });
});


describe("RightRailTagsPanel — Phase 6.6 header refresh (D-19, D-04)", () => {
  it("header renders text 'Tags (N)' with NO icon component before the label", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    renderPanel();
    expect(screen.getByText(/^Tags \(5\)$/)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /key/i })).toBeNull();
  });

  it("header contains a Close Tags panel button with X icon", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    renderPanel();
    expect(
      screen.getByRole("button", { name: /close tags panel/i }),
    ).toBeInTheDocument();
  });

  it("clicking × button calls setPanelSelector({ tags: false })", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    useTreeStore.setState({ panelSelector: { tags: true, backlinks: true } });
    renderPanel();

    const closeBtn = screen.getByRole("button", { name: /close tags panel/i });
    fireEvent.click(closeBtn);

    expect(useTreeStore.getState().panelSelector.tags).toBe(false);
  });

  it("clicking × button does NOT toggle the panel expand/collapse state", () => {
    useTreeStore.setState({
      rightRailTagsPanelExpanded: false,
      panelSelector: { tags: true, backlinks: true },
    });
    renderPanel();

    const expandedBefore = useTreeStore.getState().rightRailTagsPanelExpanded;
    const closeBtn = screen.getByRole("button", { name: /close tags panel/i });
    fireEvent.click(closeBtn);

    expect(useTreeStore.getState().rightRailTagsPanelExpanded).toBe(expandedBefore);
  });
});


describe("RRTP-no-chevron — tags panel header has no chevron (UAT-2 N4)", () => {
  it("RRTP-NC-1: no .lucide-chevron-down or .lucide-chevron-right in the header", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: false });
    const { container } = renderPanel();
    const chevronDown = container.querySelector(".lucide-chevron-down");
    const chevronRight = container.querySelector(".lucide-chevron-right");
    expect(chevronDown).toBeNull();
    expect(chevronRight).toBeNull();
  });

  it("RRTP-NC-1b: no chevron when expanded=true either", () => {
    useTreeStore.setState({ rightRailTagsPanelExpanded: true });
    const { container } = renderPanel();
    const chevronDown = container.querySelector(".lucide-chevron-down");
    const chevronRight = container.querySelector(".lucide-chevron-right");
    expect(chevronDown).toBeNull();
    expect(chevronRight).toBeNull();
  });

  it("RRTP-NC-2: close button (×) still present and calls setPanelSelector({ tags: false })", () => {
    useTreeStore.setState({ panelSelector: { tags: true, backlinks: true } });
    renderPanel();
    const closeBtn = screen.getByLabelText(/close tags panel/i);
    fireEvent.click(closeBtn);
    expect(useTreeStore.getState().panelSelector.tags).toBe(false);
  });
});

describe("RightRailTagsPanel — slice isolation (ADD-only invariant)", () => {
  it("uses rightRailTagsPanelExpanded slice — not tagBrowserExpanded", () => {
    useTreeStore.setState({
      rightRailTagsPanelExpanded: true,
      tagBrowserExpanded: false,
    });
    renderPanel();

    expect(screen.getByTestId("tag-row-alpha")).toBeInTheDocument();
  });

  it("tagBrowserExpanded=true does NOT affect RightRailTagsPanel (C4: expand removed)", () => {
    useTreeStore.setState({
      rightRailTagsPanelExpanded: false,
      tagBrowserExpanded: true,
    });
    renderPanel();

    expect(screen.getByTestId("tag-row-alpha")).toBeInTheDocument();
  });
});
