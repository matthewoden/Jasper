/**
 * StatusBar tests — Phase 6.6 Plan 10.
 *
 * Tests:
 *   1. Renders a <footer> with background, borderTop, height styling
 *   2. Renders ConnectionStatusDot as the leftmost element
 *   3. Renders a refresh button with aria-label="Reindex notes" and RefreshCw icon (14px)
 *   4. Clicking the refresh button calls postAdminReindex("incremental")
 *   5. While refresh is in-flight, icon is replaced by Loader2 AND button is disabled
 *   6. After refresh resolves, icon returns to RefreshCw and button is enabled
 *   7. Renders a flex spacer between refresh and settings
 *   8. Renders SettingsMenu as the rightmost element
 *   9. Container has zIndex: 10
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mock postAdminReindex
vi.mock("../lib/adminApi", () => ({
  postAdminReindex: vi.fn().mockResolvedValue({ data: {}, response: { status: 200 } }),
}));

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

import { postAdminReindex } from "../lib/adminApi";
import { useTreeStore } from "../lib/useTreeStore";
import { StatusBar } from "./StatusBar";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("<StatusBar />", () => {
  it("Test1_RendersFooterWithCorrectStyles", () => {
    const { container } = render(<StatusBar />);
    const footer = container.querySelector("footer");
    expect(footer).not.toBeNull();
    expect(footer?.style.background).toBe("var(--color-surface)");
    expect(footer?.style.borderTop).toBe("1px solid var(--color-border)");
    expect(footer?.style.height).toBe("32px");
  });

  it("Test2_RendersConnectionStatusDotAsFirstChild", () => {
    render(<StatusBar />);
    const dot = screen.getByTestId("connection-status-dot");
    expect(dot).toBeInTheDocument();
    // Verify it appears before the refresh button (earlier in the DOM)
    const refreshBtn = screen.getByRole("button", { name: "Reindex notes" });
    expect(
      dot.compareDocumentPosition(refreshBtn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("Test3_RendersRefreshButtonWithCorrectAriaAndIcon", () => {
    render(<StatusBar />);
    const btn = screen.getByRole("button", { name: "Reindex notes" });
    expect(btn).toBeInTheDocument();
    expect(btn.getAttribute("title")).toBe("Reindex notes");
    // Icon should be the RefreshCw svg (14px lucide icon)
    const icon = btn.querySelector("svg");
    expect(icon).not.toBeNull();
  });

  it("Test4_ClickingRefreshCallsPostAdminReindex", async () => {
    render(<StatusBar />);
    const btn = screen.getByRole("button", { name: "Reindex notes" });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(postAdminReindex).toHaveBeenCalledWith("incremental");
  });

  it("Test5_WhileInFlight_IconIsLoader2AndButtonIsDisabled", async () => {
    const d = deferred();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(postAdminReindex).mockImplementationOnce(() => d.promise as any);

    render(<StatusBar />);
    const btn = screen.getByRole("button", { name: "Reindex notes" });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(btn).toBeDisabled();
    });

    // Verify the icon has animate-spin class (Loader2 spinner)
    const icon = btn.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("class") ?? "").toMatch(/animate-spin/);

    // Resolve to clean up
    await act(async () => {
      d.resolve();
      await d.promise;
    });
  });

  it("Test6_AfterRefreshResolves_IconReturnsAndButtonIsEnabled", async () => {
    const d = deferred();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(postAdminReindex).mockImplementationOnce(() => d.promise as any);

    render(<StatusBar />);
    const btn = screen.getByRole("button", { name: "Reindex notes" });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(btn).toBeDisabled();
    });

    await act(async () => {
      d.resolve();
      await d.promise;
    });

    await waitFor(() => {
      expect(btn).not.toBeDisabled();
    });

    // Icon should NOT have animate-spin after resolving
    const icon = btn.querySelector("svg");
    expect(icon?.getAttribute("class") ?? "").not.toMatch(/animate-spin/);
  });

  it("Test7_RendersFlex1SpacerBetweenRefreshAndSettings", () => {
    const { container } = render(<StatusBar />);
    const spacer = container.querySelector("[data-testid='status-bar-spacer']");
    expect(spacer).not.toBeNull();
    expect(spacer?.getAttribute("style") ?? "").toContain("flex: 1");
  });

  it("Test8_RendersSettingsMenuAsRightmostElement", () => {
    const { container } = render(<StatusBar />);
    const settingsTrigger = screen.getByTestId("settings-menu-trigger");
    expect(settingsTrigger).toBeInTheDocument();
    // Verify spacer appears before settings trigger in DOM order
    const spacer = container.querySelector("[data-testid='status-bar-spacer']");
    expect(spacer).not.toBeNull();
    // spacer should come before the settings trigger (settings is after spacer)
    expect(
      spacer!.compareDocumentPosition(settingsTrigger) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("Test9_ContainerHasZIndex10", () => {
    const { container } = render(<StatusBar />);
    const footer = container.querySelector("footer");
    expect(footer?.style.zIndex).toBe("10");
  });
});

describe("SB-save-indicator — SaveIndicator rendered in StatusBar (UAT-2 N9)", () => {
  it("SB-SI-1: renders SaveIndicator with current store saveState=saving", async () => {
    useTreeStore.setState({ saveState: { status: "saving", startedAt: new Date() } });
    render(<StatusBar />);
    expect(screen.getByText("Saving…")).toBeInTheDocument();
  });

  it("SB-SI-2: renders SaveIndicator with saveState=saved", async () => {
    useTreeStore.setState({ saveState: { status: "saved", savedAt: new Date() } });
    render(<StatusBar />);
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("SB-SI-3: renders nothing visible for saveState=idle", () => {
    useTreeStore.setState({ saveState: { status: "idle" } });
    render(<StatusBar />);
    // SaveIndicator returns null for idle — no "Saving" or "Saved" text
    expect(screen.queryByText("Saving…")).not.toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });
});
