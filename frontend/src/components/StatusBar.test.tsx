/**
 * StatusBar tests — Phase 6.6 Plan 10 / updated by Plan 07-37 (UAT-3 N9).
 *
 * Plan 07-37 simplifies StatusBar back to a minimal surface:
 *   ConnectionStatusDot → spacer → SettingsMenu
 *
 * The standalone "Reindex notes" refresh button (Plan 06.6) and the
 * SaveIndicator (hoisted into StatusBar by Plan 07-28 / B3) are BOTH
 * removed — they're unified as the SaveIndicator-as-refresh-button hybrid
 * in TopBar's right cluster (D-55 in 07-CONTEXT.md).
 *
 * Tests:
 *   1. Renders a <footer> with background, borderTop, height styling
 *   2. Renders ConnectionStatusDot
 *   3. Renders a flex spacer between left-side connection dot and right-side settings
 *   4. Renders SettingsMenu as the rightmost element
 *   5. Container has zIndex: 10
 *
 * Negative assertions (Plan 07-37):
 *   - SB-NO-REFRESH: NO standalone "Reindex notes" button is rendered
 *   - SB-NO-SAVE-INDICATOR: NO SaveIndicator (no [data-save-state] / no
 *     "Saving…" / "Saved" text) is rendered
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mock client (used by SettingsMenu → useTheme → useConfig)
vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn().mockResolvedValue({
      data: {
        appName: "Jasper",
        theme: "dark",
        dailyNotes: { folder: "daily", template: "" },
        editor: { fontSize: 15, lineHeight: 1.6, vimMode: false },
      },
      response: { status: 200 },
    }),
    PUT: vi.fn().mockResolvedValue({
      data: {},
      response: { status: 200 },
    }),
  },
}));

import { useTreeStore } from "../lib/useTreeStore";
import { StatusBar } from "./StatusBar";

describe("<StatusBar />", () => {
  it("Test1_RendersFooterWithCorrectStyles", () => {
    const { container } = render(<StatusBar />);
    const footer = container.querySelector("footer");
    expect(footer).not.toBeNull();
    expect(footer?.style.background).toBe("var(--color-surface)");
    expect(footer?.style.borderTop).toBe("1px solid var(--color-border)");
    expect(footer?.style.height).toBe("32px");
  });

  it("Test2_RendersConnectionStatusDot", () => {
    render(<StatusBar />);
    const dot = screen.getByTestId("connection-status-dot");
    expect(dot).toBeInTheDocument();
  });

  it("Test3_RendersFlex1SpacerBetweenConnectionDotAndSettings", () => {
    const { container } = render(<StatusBar />);
    const spacer = container.querySelector("[data-testid='status-bar-spacer']");
    expect(spacer).not.toBeNull();
    expect(spacer?.getAttribute("style") ?? "").toContain("flex: 1");
    // Connection dot must come before the spacer (left side); settings after.
    const dot = screen.getByTestId("connection-status-dot");
    expect(
      dot.compareDocumentPosition(spacer!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("Test4_RendersSettingsMenuAsRightmostElement", () => {
    const { container } = render(<StatusBar />);
    const settingsTrigger = screen.getByTestId("settings-menu-trigger");
    expect(settingsTrigger).toBeInTheDocument();
    const spacer = container.querySelector("[data-testid='status-bar-spacer']");
    expect(spacer).not.toBeNull();
    // Spacer should come before the settings trigger (settings is after spacer).
    expect(
      spacer!.compareDocumentPosition(settingsTrigger) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("Test5_ContainerHasZIndex10", () => {
    const { container } = render(<StatusBar />);
    const footer = container.querySelector("footer");
    expect(footer?.style.zIndex).toBe("10");
  });
});

// ── Plan 07-37 (UAT-3 N9) — negative assertions ────────────────────────────
//
// StatusBar must NO LONGER render the standalone refresh button or the
// SaveIndicator (both moved into the SaveIndicator-as-refresh-button hybrid
// in TopBar's right cluster).

describe("StatusBar — Plan 07-37 removals (UAT-3 N9)", () => {
  it("SB-NO-REFRESH: no standalone 'Reindex notes' button is rendered", () => {
    render(<StatusBar />);
    expect(screen.queryByRole("button", { name: "Reindex notes" })).toBeNull();
  });

  it("SB-NO-SAVE-INDICATOR-1: no [data-save-state] element (button-mode SaveIndicator) is rendered", () => {
    const { container } = render(<StatusBar />);
    expect(container.querySelector("[data-save-state]")).toBeNull();
  });

  it("SB-NO-SAVE-INDICATOR-2: even when store.saveState=saving, no 'Saving…' text appears in the status bar", () => {
    useTreeStore.setState({ saveState: { status: "saving", startedAt: new Date() } });
    render(<StatusBar />);
    expect(screen.queryByText("Saving…")).toBeNull();
  });

  it("SB-NO-SAVE-INDICATOR-3: even when store.saveState=saved, no 'Saved' text appears in the status bar", () => {
    useTreeStore.setState({ saveState: { status: "saved", savedAt: new Date() } });
    render(<StatusBar />);
    expect(screen.queryByText("Saved")).toBeNull();
  });
});
