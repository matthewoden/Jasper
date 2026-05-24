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

// Plan 08-17c: mock useVaultPicker so StatusBar doesn't spin up real API calls.
// Default: current=null (no vault active) so the vault segment is not rendered.
const mockUseVaultPickerOpen = vi.fn();
vi.mock("../lib/useVaultPicker", () => ({
  useVaultPicker: vi.fn(() => ({
    isOpen: false,
    open: mockUseVaultPickerOpen,
    close: vi.fn(),
    current: null,
    recents: [],
    banner: "",
    isLoading: false,
    refresh: vi.fn(),
  })),
}));

// Plan 08-17c: mock vaultApi used by VaultPicker (mounted as switch-mode modal in StatusBar).
vi.mock("../lib/vaultApi", () => ({
  vaultApi: {
    getCurrent: vi.fn().mockResolvedValue(null),
    getRecent: vi.fn().mockResolvedValue({ vaults: [], banner: "" }),
    open: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
    forget: vi.fn().mockResolvedValue(undefined),
  },
  validateVaultPath: vi.fn().mockReturnValue({ ok: true }),
}));

import { StatusBar } from "./StatusBar";
import { useVaultPicker } from "../lib/useVaultPicker";

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

// ── Plan 07-37 (UAT-3 N9) — superseded by Plan 07-38 (UAT-4 N9) ────────────
//
// Plan 07-37 removed the SaveIndicator from StatusBar. Plan 07-38 user
// reversal puts it BACK — SaveIndicator as a clickable button lives in
// StatusBar's metadata zone. The standalone "Reindex notes" button stays
// removed (the SaveIndicator-button merger from Plan 07-37 D-55 IS preserved
// — only the mount location is reverted).

describe("StatusBar — Plan 07-38 (UAT-4 N9) restored SaveIndicator-button", () => {
  it("SB-NO-REFRESH (preserved): no standalone 'Reindex notes' button is rendered (D-55 merge kept)", () => {
    render(<StatusBar />);
    expect(screen.queryByRole("button", { name: "Reindex notes" })).toBeNull();
  });

  it("SB-N9-1: StatusBar renders a SaveIndicator-button (button[data-save-state]) in the metadata zone", () => {
    const { container } = render(<StatusBar />);
    const btn = container.querySelector("button[data-save-state]");
    expect(btn).not.toBeNull();
  });

  it("SB-N9-2: clicking the SaveIndicator-button calls postAdminReindex('incremental')", async () => {
    // postAdminReindex is mocked here so the StatusBar wiring is isolated
    // from the network. The Task 3 GREEN implementation imports
    // postAdminReindex from adminApi and wires it to the SaveIndicator's
    // onClick — same pattern as the (since-reverted) TopBar mount.
    const adminApi = await import("../lib/adminApi");
    const spy = vi.spyOn(adminApi, "postAdminReindex").mockResolvedValue({
      data: undefined,
      error: undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    try {
      const { container } = render(<StatusBar />);
      const btn = container.querySelector(
        "button[data-save-state]",
      ) as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      btn!.click();
      expect(spy).toHaveBeenCalledWith("incremental");
    } finally {
      spy.mockRestore();
    }
  });

  it("SB-N9-3: the standalone 'Reindex notes' button is NOT rendered (Plan 07-37 removal preserved)", () => {
    render(<StatusBar />);
    // Title attribute used by Phase 06.6 refresh button.
    expect(screen.queryByTitle("Reindex notes")).toBeNull();
  });
});

// ── Plan 08-17c (V7) — vault segment in StatusBar ────────────────────────────
describe("StatusBar — Plan 08-17c vault segment", () => {
  it("SB-VAULT-1: vault segment NOT rendered when current is null", () => {
    vi.mocked(useVaultPicker).mockReturnValue({
      isOpen: false,
      open: vi.fn(),
      close: vi.fn(),
      current: null,
      recents: [],
      banner: "",
      isLoading: false,
      refresh: vi.fn(),
    });
    render(<StatusBar />);
    expect(screen.queryByTestId("status-bar-vault")).toBeNull();
  });

  it("SB-VAULT-2: vault segment renders display_name when current is non-null", () => {
    vi.mocked(useVaultPicker).mockReturnValue({
      isOpen: false,
      open: vi.fn(),
      close: vi.fn(),
      current: {
        path: "/Users/me/vault",
        display_name: "My Notes",
        last_opened_at: "2026-05-24T00:00:00Z",
        created_at: "2026-05-24T00:00:00Z",
        missing: false,
      },
      recents: [],
      banner: "",
      isLoading: false,
      refresh: vi.fn(),
    });
    render(<StatusBar />);
    expect(screen.getByTestId("status-bar-vault")).toBeInTheDocument();
    expect(screen.getByTestId("status-bar-vault")).toHaveTextContent("My Notes");
  });

  it("SB-VAULT-3: clicking the vault segment calls open() from useVaultPicker", () => {
    const openFn = vi.fn();
    vi.mocked(useVaultPicker).mockReturnValue({
      isOpen: false,
      open: openFn,
      close: vi.fn(),
      current: {
        path: "/Users/me/vault",
        display_name: "My Notes",
        last_opened_at: "2026-05-24T00:00:00Z",
        created_at: "2026-05-24T00:00:00Z",
        missing: false,
      },
      recents: [],
      banner: "",
      isLoading: false,
      refresh: vi.fn(),
    });
    render(<StatusBar />);
    const segment = screen.getByTestId("status-bar-vault");
    segment.click();
    expect(openFn).toHaveBeenCalled();
  });
});
