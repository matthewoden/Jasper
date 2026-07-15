/**
 * StatusBar tests.
 *
 * Layout: [ConnectionStatusDot] [vault segment?] [spacer] [SaveIndicator-button] [SettingsMenu]
 *
 * Positive assertions: footer styles, ConnectionStatusDot, spacer, SettingsMenu placement,
 * zIndex, SaveIndicator-button presence and click behavior, vault segment.
 * Negative assertions: no standalone "Reindex notes" button.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "../lib/useTreeStore";


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
    expect(screen.queryByTitle("Reindex notes")).toBeNull();
  });
});


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


describe("StatusBar — Phase 22 Plan 03 zen toggle button (ZEN-01)", () => {
  beforeEach(() => {
    useTreeStore.setState({ zen: false });
  });
  afterEach(() => {
    useTreeStore.setState({ zen: false });
  });

  it("ZEN-SB-1: renders a zen toggle button with aria-label 'Toggle zen mode'", () => {
    render(<StatusBar />);
    const btn = screen.getByLabelText("Toggle zen mode");
    expect(btn).toBeInTheDocument();
  });

  it("ZEN-SB-2: clicking the zen toggle button flips the zen store slice", () => {
    render(<StatusBar />);
    const btn = screen.getByLabelText("Toggle zen mode");
    expect(useTreeStore.getState().zen).toBe(false);
    btn.click();
    expect(useTreeStore.getState().zen).toBe(true);
  });

  it("ZEN-SB-3: the zen icon uses the accent color when zen is active", () => {
    useTreeStore.setState({ zen: true });
    render(<StatusBar />);
    const btn = screen.getByLabelText("Toggle zen mode");
    const icon = btn.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("color")).toBe("var(--color-accent)");
  });

  it("ZEN-SB-4: the zen icon uses the muted color when zen is inactive", () => {
    render(<StatusBar />);
    const btn = screen.getByLabelText("Toggle zen mode");
    const icon = btn.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("color")).toBe("var(--color-muted)");
  });
});
