/**
 * TopBar.test.tsx — Phase 06.6-09 (UX-CHROME-01)
 *
 * Tests: composition (sidebar toggle, Breadcrumbs, PanelSelectorDropdown,
 * right-rail toggle), style tokens, aria-label state reflection, toggle
 * callbacks, style prop merge.
 *
 * Child components (Breadcrumbs, PanelSelectorDropdown) are mocked to keep
 * tests focused on TopBar-specific behavior only.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
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

vi.mock("../lib/useTreeStore", () => ({
  useTreeStore: (selector: (s: unknown) => unknown) => {
    const state = {
      notesSidebarVisible: mockNotesSidebarVisible,
      setNotesSidebarVisible: mockSetNotesSidebarVisible,
      backlinksRailExpanded: mockBacklinksRailExpanded,
      setBacklinksRailExpanded: mockSetBacklinksRailExpanded,
      activeNoteId: "note-1",
    };
    return selector(state);
  },
}));

// Mock useTagBrowser and useBacklinks for C3 (N3) tests
let mockTagCount = 0;
let mockBacklinkCount = 0;

vi.mock("../lib/useTagBrowser", () => ({
  useTagBrowser: () => ({
    tags: Array.from({ length: mockTagCount }, (_, i) => ({ name: `tag${i}`, count: 1 })),
    loading: false,
    error: null,
    refresh: vi.fn(),
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

describe("RR-toggle-hide — right-rail toggle hidden when no items (UAT-2 N3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotesSidebarVisible = true;
    mockBacklinksRailExpanded = true;
  });

  it("RR-T-1: zero tags + zero backlinks → right-rail toggle button NOT rendered", () => {
    mockTagCount = 0;
    mockBacklinkCount = 0;
    render(<TopBar />);
    // The right-rail toggle (Hide/Show panels) should NOT be in the DOM
    expect(screen.queryByRole("button", { name: /hide panels|show panels/i })).toBeNull();
  });

  it("RR-T-2: 1 tag + zero backlinks → right-rail toggle button IS rendered", () => {
    mockTagCount = 1;
    mockBacklinkCount = 0;
    render(<TopBar />);
    // Toggle should appear when there are tags
    expect(screen.queryByRole("button", { name: /hide panels|show panels/i })).not.toBeNull();
  });

  it("RR-T-3: zero tags + 1 backlink → right-rail toggle button IS rendered", () => {
    mockTagCount = 0;
    mockBacklinkCount = 1;
    render(<TopBar />);
    // Toggle should appear when there are backlinks
    expect(screen.queryByRole("button", { name: /hide panels|show panels/i })).not.toBeNull();
  });
});
