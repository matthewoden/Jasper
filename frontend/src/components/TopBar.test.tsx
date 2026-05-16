/**
 * TopBar.test.tsx — Phase 06.6-09 (UX-CHROME-01)
 *
 * Tests: composition (sidebar toggle, Breadcrumbs, PanelSelectorDropdown,
 * right-rail toggle), style tokens, aria-label state reflection, toggle
 * callbacks, style prop merge.
 *
 * Child components (Breadcrumbs, PanelSelectorDropdown) are mocked to keep
 * tests focused on TopBar-specific behavior only.
 *
 * Plan 07-37 (UAT-3 N9): TopBar additionally mounts the SaveIndicator-button
 * (the unified SaveIndicator + manual-refresh hybrid). The TBR-SI-* tests
 * below pin this behavior; SaveIndicator + adminApi are mocked here so the
 * test stays focused on TopBar's wiring (button mount / click → reindex /
 * state reflection).
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock postAdminReindex BEFORE TopBar imports adminApi (transitively).
vi.mock("../lib/adminApi", () => ({
  postAdminReindex: vi.fn().mockResolvedValue({ data: {}, response: { status: 200 } }),
}));

import { postAdminReindex } from "../lib/adminApi";
import { TopBar } from "./TopBar";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("./Breadcrumbs", () => ({
  Breadcrumbs: () => <div data-testid="mock-breadcrumbs">Breadcrumbs</div>,
}));

vi.mock("./PanelSelectorDropdown", () => ({
  PanelSelectorDropdown: () => (
    <div data-testid="mock-panel-selector-dropdown">PanelSelectorDropdown</div>
  ),
}));

// Mock useTreeStore — default state and mock setters
const mockSetNotesSidebarVisible = vi.fn();
const mockSetBacklinksRailExpanded = vi.fn();

let mockNotesSidebarVisible = true;
let mockBacklinksRailExpanded = true;
// Plan 07-37: TopBar reads useTreeStore.saveState for the SaveIndicator-button.
// Each test can override before render via this mutable holder.
let mockSaveState: import("../lib/saveStateMachine").SaveState = { status: "idle" };
// Plan 07-38 (UAT-4 N3): TopBar reads useTreeStore.panelSelector to gate
// the right-rail toggle. Default = both panels selected (matches the
// store default `panelSelector: { tags: true, backlinks: true }`).
let mockPanelSelector: { tags: boolean; backlinks: boolean } = {
  tags: true,
  backlinks: true,
};
// Plan 07-38 (UAT-4 N3): activeNoteId is now nullable in tests — when null
// the user is looking at attachment preview / scratchpad, but panel
// selector + rail toggle behavior should still respect panelSelector state.
let mockActiveNoteId: string | null = "note-1";

vi.mock("../lib/useTreeStore", () => ({
  useTreeStore: (selector: (s: unknown) => unknown) => {
    const state = {
      notesSidebarVisible: mockNotesSidebarVisible,
      setNotesSidebarVisible: mockSetNotesSidebarVisible,
      backlinksRailExpanded: mockBacklinksRailExpanded,
      setBacklinksRailExpanded: mockSetBacklinksRailExpanded,
      activeNoteId: mockActiveNoteId,
      saveState: mockSaveState,
      panelSelector: mockPanelSelector,
    };
    return selector(state);
  },
}));

// Mock useTagsForNote (Plan 07-35: replaces global useTagBrowser with per-note semantics)
// and useBacklinks for C3/N3 tests.
let mockTagCount = 0;
let mockBacklinkCount = 0;

vi.mock("../lib/useTagsForNote", () => ({
  useTagsForNote: () => ({
    tags: Array.from({ length: mockTagCount }, (_, i) => `tag${i}`),
    loading: false,
    error: null,
  }),
}));

vi.mock("../lib/useBacklinks", () => ({
  useBacklinks: () => ({
    backlinks: Array.from({ length: mockBacklinkCount }, (_, i) => ({ id: `b${i}`, title: `Note ${i}`, path: `note${i}.md` })),
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TopBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockBacklinksRailExpanded = true;
    mockTagCount = 1;
    mockBacklinkCount = 0;
  });

  // Test 1: Container style — background + boxShadow + height
  it("renders a container with the correct background, boxShadow, and height styles", () => {
    render(<TopBar />);
    const container = screen.getByTestId("top-bar");
    expect(container.style.background).toBe("var(--color-bg)");
    expect(container.style.boxShadow).toBe("var(--shadow-elevation-1)");
    expect(container.style.height).toBe("40px");
  });

  // Test 2: Sidebar toggle aria-label when notesSidebarVisible=true
  it("shows aria-label 'Hide notes sidebar' when notesSidebarVisible is true", () => {
    mockNotesSidebarVisible = true;
    render(<TopBar />);
    expect(
      screen.getByRole("button", { name: "Hide notes sidebar" }),
    ).toBeTruthy();
  });

  // Test 3: Sidebar toggle aria-label when notesSidebarVisible=false
  it("shows aria-label 'Show notes sidebar' when notesSidebarVisible is false", () => {
    mockNotesSidebarVisible = false;
    render(<TopBar />);
    expect(
      screen.getByRole("button", { name: "Show notes sidebar" }),
    ).toBeTruthy();
  });

  // Test 4: Clicking sidebar toggle calls setNotesSidebarVisible(!current)
  it("calls setNotesSidebarVisible(!notesSidebarVisible) when sidebar toggle clicked", () => {
    mockNotesSidebarVisible = true;
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Hide notes sidebar" }));
    expect(mockSetNotesSidebarVisible).toHaveBeenCalledWith(false);
  });

  it("calls setNotesSidebarVisible(true) when sidebar toggle clicked and sidebar is hidden", () => {
    mockNotesSidebarVisible = false;
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Show notes sidebar" }));
    expect(mockSetNotesSidebarVisible).toHaveBeenCalledWith(true);
  });

  // Test 5: Renders the Breadcrumbs component
  it("renders the Breadcrumbs component", () => {
    render(<TopBar />);
    expect(screen.getByTestId("mock-breadcrumbs")).toBeTruthy();
  });

  // Test 6: Renders the PanelSelectorDropdown component
  it("renders the PanelSelectorDropdown component", () => {
    render(<TopBar />);
    expect(screen.getByTestId("mock-panel-selector-dropdown")).toBeTruthy();
  });

  // Test 7: Right-rail toggle aria-label reflects backlinksRailExpanded state
  it("shows aria-label 'Hide panels' when backlinksRailExpanded is true", () => {
    mockBacklinksRailExpanded = true;
    render(<TopBar />);
    expect(screen.getByRole("button", { name: "Hide panels" })).toBeTruthy();
  });

  it("shows aria-label 'Show panels' when backlinksRailExpanded is false", () => {
    mockBacklinksRailExpanded = false;
    render(<TopBar />);
    expect(screen.getByRole("button", { name: "Show panels" })).toBeTruthy();
  });

  // Test 8: Clicking right-rail toggle calls setBacklinksRailExpanded(!current)
  it("calls setBacklinksRailExpanded(!backlinksRailExpanded) when right-rail toggle clicked", () => {
    mockBacklinksRailExpanded = true;
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Hide panels" }));
    expect(mockSetBacklinksRailExpanded).toHaveBeenCalledWith(false);
  });

  it("calls setBacklinksRailExpanded(true) when right-rail toggle clicked and rail is hidden", () => {
    mockBacklinksRailExpanded = false;
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Show panels" }));
    expect(mockSetBacklinksRailExpanded).toHaveBeenCalledWith(true);
  });

  // Test 9: zIndex is 10
  it("has zIndex 10 on the container", () => {
    render(<TopBar />);
    const container = screen.getByTestId("top-bar");
    expect(container.style.zIndex).toBe("10");
  });

  // Test 10: Optional style prop merges into root container style
  it("merges extra style props into the container (e.g. gridRow, gridColumn)", () => {
    render(<TopBar style={{ gridRow: "1", gridColumn: "2" }} />);
    const container = screen.getByTestId("top-bar");
    expect(container.style.gridRow).toBe("1");
    expect(container.style.gridColumn).toBe("2");
    // Original styles must still be present
    expect(container.style.background).toBe("var(--color-bg)");
  });
});

// ── RR-toggle-hide: C3 (UAT-2 N3) — right-rail toggle hidden when no items ──
//
// SUPERSEDED by Plan 07-38 / UAT-4 N3 — the toggle is now gated on
// `useTreeStore.panelSelector.{tags,backlinks}` (panel-selection state),
// NOT on the active note's tag/backlink content. These tests are rewritten
// to reflect the new gate: zero tags / backlinks no longer hides the toggle
// when at least one panel is selected. See TBR-N3 suite below for the new
// authoritative cases.

describe("RR-toggle-hide — right-rail toggle gate (Plan 07-38 supersedes UAT-2 N3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockBacklinksRailExpanded = true;
    mockPanelSelector = { tags: true, backlinks: true }; // store default
  });

  it("RR-T-1 (Plan 07-38): zero tags + zero backlinks BUT default panelSelector=both-selected → toggle RENDERED", () => {
    mockTagCount = 0;
    mockBacklinkCount = 0;
    // The previous (Plan 07-30) behavior hid the toggle here; Plan 07-38
    // reverses that — the gate is now panelSelector, not content.
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: /hide panels|show panels/i })).not.toBeNull();
  });

  it("RR-T-2: 1 tag → toggle still rendered (unchanged)", () => {
    mockTagCount = 1;
    mockBacklinkCount = 0;
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: /hide panels|show panels/i })).not.toBeNull();
  });

  it("RR-T-3: 1 backlink → toggle still rendered (unchanged)", () => {
    mockTagCount = 0;
    mockBacklinkCount = 1;
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: /hide panels|show panels/i })).not.toBeNull();
  });
});

// ── TBR-FIX: SUPERSEDED — see TBR-N3 below ──────────────────────────────────
//
// Plan 07-35's per-note hasContent gate is reversed by Plan 07-38: the
// panel-selector state is the authoritative gate now, NOT the active note's
// content. We keep one positive case (panelSelector=true → toggle visible)
// to lock that contract; the per-note-content cases are obsolete.

describe("TBR-FIX (superseded by Plan 07-38) — content no longer gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockBacklinksRailExpanded = true;
    mockPanelSelector = { tags: true, backlinks: true };
  });

  it("TBR-FIX-2 (kept): toggle visible when panelSelector indicates any panel selected", () => {
    mockTagCount = 1;
    mockBacklinkCount = 0;
    render(<TopBar />);
    expect(screen.queryByRole("button", { name: /hide panels|show panels/i })).not.toBeNull();
  });
});

// ── TBR-SI: Plan 07-37 (UAT-3 N9 / D-55) — SaveIndicator-button in TopBar ──
//
// TopBar mounts the unified SaveIndicator-as-refresh-button (replaces the
// standalone refresh button + SaveIndicator that previously lived in
// StatusBar via Plan 07-28). The button is in the right cluster, ALWAYS
// rendered (not gated by hasContent — refresh is always available).

describe("TBR-SI — SaveIndicator-button in TopBar (Plan 07-37 / UAT-3 N9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockBacklinksRailExpanded = true;
    mockTagCount = 0;
    mockBacklinkCount = 0;
    mockSaveState = { status: "idle" };
  });

  it("TBR-SI-1: renders the SaveIndicator-button (data-save-state attr present) even with no panel selected", () => {
    // Plan 07-38 (UAT-4 N3): the toggle gate is now panelSelector, not
    // content. To confirm the SaveIndicator is independent of the toggle
    // gating, set panelSelector all-false → toggle hidden, but the
    // SaveIndicator-button MUST still render.
    mockTagCount = 0;
    mockBacklinkCount = 0;
    mockPanelSelector = { tags: false, backlinks: false };
    const { container } = render(<TopBar />);
    const btn = container.querySelector("button[data-save-state]");
    expect(btn).not.toBeNull();
    // The right-rail toggle should be hidden under panelSelector all-false.
    expect(
      screen.queryByRole("button", { name: /hide panels|show panels/i }),
    ).toBeNull();
  });

  it("TBR-SI-2: clicking the SaveIndicator-button calls postAdminReindex('incremental')", () => {
    const { container } = render(<TopBar />);
    const btn = container.querySelector("button[data-save-state]");
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(postAdminReindex).toHaveBeenCalledWith("incremental");
  });

  it("TBR-SI-3: SaveIndicator-button reflects useTreeStore.saveState.status", () => {
    mockSaveState = { status: "saving", startedAt: new Date() };
    const { container } = render(<TopBar />);
    const btn = container.querySelector("button[data-save-state]");
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("data-save-state")).toBe("saving");
    // saving → disabled (T-37-01 DoS guard inside SaveIndicator).
    expect((btn as HTMLButtonElement | null)?.disabled).toBe(true);
  });

  it("TBR-SI-4: SaveIndicator-button renders inside the right-side cluster (after Breadcrumbs in DOM order)", () => {
    const { container } = render(<TopBar />);
    const btn = container.querySelector("button[data-save-state]");
    const breadcrumbs = screen.getByTestId("mock-breadcrumbs");
    expect(btn).not.toBeNull();
    // breadcrumbs (left group) must come before the SaveIndicator-button (right cluster).
    expect(
      breadcrumbs.compareDocumentPosition(btn!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("TBR-SI-5: when hasContent is true, SaveIndicator-button comes BEFORE the panel selector + right-rail toggle", () => {
    mockTagCount = 1; // engages hasContent → panel selector + rail toggle render
    mockBacklinkCount = 0;
    const { container } = render(<TopBar />);
    const btn = container.querySelector("button[data-save-state]");
    const panelSelector = screen.getByTestId("mock-panel-selector-dropdown");
    expect(btn).not.toBeNull();
    // SaveIndicator-button is the leftmost item in the right cluster, so
    // it must appear in DOM order BEFORE the panel-selector dropdown.
    expect(
      btn!.compareDocumentPosition(panelSelector) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

// ── TBR-N3: Plan 07-38 (UAT-4 N3) — PanelSelectorDropdown always visible ──
//
// Per the user clarification captured in 07-HUMAN-UAT-4.md, the
// PanelSelectorDropdown should be rendered UNCONDITIONALLY (regardless of
// whether the active note has tags/backlinks, or even whether there is an
// active note). The right-rail toggle should only be gated on
// `useTreeStore.panelSelector.{tags, backlinks}` — i.e. is any panel
// currently selected? Plan 07-35's hasContent gate is reversed.

describe("TBR-N3 — PanelSelectorDropdown always visible + selection-gated rail toggle (Plan 07-38)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockBacklinksRailExpanded = true;
    mockTagCount = 0;
    mockBacklinkCount = 0;
    mockActiveNoteId = "note-1";
    mockPanelSelector = { tags: true, backlinks: true };
    mockSaveState = { status: "idle" };
  });

  it("TBR-N3-1: PanelSelectorDropdown is rendered when activeNote has 0 tags + 0 backlinks", () => {
    mockTagCount = 0;
    mockBacklinkCount = 0;
    render(<TopBar />);
    expect(screen.queryByTestId("mock-panel-selector-dropdown")).not.toBeNull();
  });

  it("TBR-N3-2: PanelSelectorDropdown is rendered when there is no active note (attachment preview)", () => {
    mockActiveNoteId = null;
    mockTagCount = 0;
    mockBacklinkCount = 0;
    render(<TopBar />);
    expect(screen.queryByTestId("mock-panel-selector-dropdown")).not.toBeNull();
  });

  it("TBR-N3-3: right-rail toggle HIDDEN when panelSelector.tags=false AND panelSelector.backlinks=false", () => {
    mockPanelSelector = { tags: false, backlinks: false };
    // Even with content in the active note, the toggle should be hidden
    // because the user has deselected every panel.
    mockTagCount = 5;
    mockBacklinkCount = 3;
    render(<TopBar />);
    expect(
      screen.queryByRole("button", { name: /hide panels|show panels/i }),
    ).toBeNull();
  });

  it("TBR-N3-4a: right-rail toggle VISIBLE when panelSelector.tags=true", () => {
    mockPanelSelector = { tags: true, backlinks: false };
    // Even with no content, the toggle should be visible because the user
    // has selected at least one panel (panel-presence gates the toggle).
    mockTagCount = 0;
    mockBacklinkCount = 0;
    render(<TopBar />);
    expect(
      screen.queryByRole("button", { name: /hide panels|show panels/i }),
    ).not.toBeNull();
  });

  it("TBR-N3-4b: right-rail toggle VISIBLE when panelSelector.backlinks=true", () => {
    mockPanelSelector = { tags: false, backlinks: true };
    mockTagCount = 0;
    mockBacklinkCount = 0;
    render(<TopBar />);
    expect(
      screen.queryByRole("button", { name: /hide panels|show panels/i }),
    ).not.toBeNull();
  });
});
