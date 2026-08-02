/**
 * StatusBar tests.
 *
 * Layout: [ConnectionStatusDot] [vault segment?] [word count?] [spacer] [SaveIndicator-button] [zen toggle]
 *
 * The duplicate Settings gear (SettingsMenu) was removed
 * from the status bar — ActivityRibbon's own gear is the sole entry point
 * now (see ActivityRibbon.test.tsx for its coverage).
 *
 * Positive assertions: footer styles, ConnectionStatusDot, spacer, zen-toggle placement,
 * zIndex, SaveIndicator-button presence and click behavior, vault segment, focused-note word count.
 * Negative assertions: no standalone "Reindex notes" button, no settings-menu-trigger.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAllControllersForTest,
  getOrCreateController,
} from "../lib/noteBufferController";
import { useTreeStore } from "../lib/useTreeStore";


vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn().mockResolvedValue({
      data: {
        appName: "Jasper",
        theme: "dark",
        dailyNotes: { template: "" },
        editor: { fontSize: 15, lineHeight: 1.6 },
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
import { TooltipProvider } from "./Tooltip";
import { useVaultPicker } from "../lib/useVaultPicker";

function renderStatusBar() {
  return render(
    <TooltipProvider>
      <StatusBar />
    </TooltipProvider>,
  );
}

describe("<StatusBar />", () => {
  it("Test1_RendersFooterWithCorrectStyles", () => {
    const { container } = renderStatusBar();
    const footer = container.querySelector("footer");
    expect(footer).not.toBeNull();
    expect(footer?.style.background).toBe("var(--color-surface)");
    expect(footer?.style.borderTop).toBe("1px solid var(--color-border)");
    expect(footer?.style.height).toBe("32px");
  });

  it("Test2_RendersConnectionStatusDot", () => {
    renderStatusBar();
    const dot = screen.getByTestId("connection-status-dot");
    expect(dot).toBeInTheDocument();
  });

  it("Test2b_DotColumnMatchesRibbonWidth (UAT #2 — ribbon-column alignment)", () => {
    renderStatusBar();
    const column = screen.getByTestId("status-bar-dot-column");
    // 48px matches ActivityRibbon's own column width; -8px marginLeft
    // cancels the footer's 8px left padding so the column starts flush at
    // the true left edge, same as the ribbon.
    expect(column.style.width).toBe("48px");
    expect(column.style.marginLeft).toBe("-8px");
  });

  it("Test3_RendersFlex1SpacerBetweenConnectionDotAndSettings", () => {
    const { container } = renderStatusBar();
    const spacer = container.querySelector("[data-testid='status-bar-spacer']");
    expect(spacer).not.toBeNull();
    expect(spacer?.getAttribute("style") ?? "").toContain("flex: 1");
    const dot = screen.getByTestId("connection-status-dot");
    expect(
      dot.compareDocumentPosition(spacer!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("Test4_DoesNotRenderSettingsMenuInStatusBar (UAT #3 — duplicate gear removed)", () => {
    renderStatusBar();
    expect(screen.queryByTestId("settings-menu-trigger")).not.toBeInTheDocument();
  });

  it("Test4b_RendersZenToggleAsRightmostElement", () => {
    const { container } = renderStatusBar();
    const zenToggle = screen.getByTestId("zen-toggle-button");
    expect(zenToggle).toBeInTheDocument();
    const spacer = container.querySelector("[data-testid='status-bar-spacer']");
    expect(spacer).not.toBeNull();
    expect(
      spacer!.compareDocumentPosition(zenToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("Test5_ContainerHasZIndex10", () => {
    const { container } = renderStatusBar();
    const footer = container.querySelector("footer");
    expect(footer?.style.zIndex).toBe("10");
  });
});


describe("StatusBar — restored SaveIndicator-button", () => {
  it("SB-NO-REFRESH (preserved): no standalone 'Reindex notes' button is rendered (merge kept)", () => {
    renderStatusBar();
    expect(screen.queryByRole("button", { name: "Reindex notes" })).toBeNull();
  });

  it("SB-N9-1: StatusBar renders a SaveIndicator-button (button[data-save-state]) in the metadata zone", () => {
    const { container } = renderStatusBar();
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
      const { container } = renderStatusBar();
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

  it("SB-N9-3: the standalone 'Reindex notes' button is NOT rendered (removal preserved)", () => {
    renderStatusBar();
    expect(screen.queryByTitle("Reindex notes")).toBeNull();
  });
});


describe("StatusBar — vault segment", () => {
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
    renderStatusBar();
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
    renderStatusBar();
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
    renderStatusBar();
    const segment = screen.getByTestId("status-bar-vault");
    segment.click();
    expect(openFn).toHaveBeenCalled();
  });
});


describe("StatusBar — zen toggle button (ZEN-01)", () => {
  beforeEach(() => {
    useTreeStore.setState({ zen: false });
  });
  afterEach(() => {
    useTreeStore.setState({ zen: false });
  });

  it("ZEN-SB-1: renders a zen toggle button with aria-label 'Toggle zen mode'", () => {
    renderStatusBar();
    const btn = screen.getByLabelText("Toggle zen mode");
    expect(btn).toBeInTheDocument();
  });

  it("ZEN-SB-2: clicking the zen toggle button flips the zen store slice", () => {
    renderStatusBar();
    const btn = screen.getByLabelText("Toggle zen mode");
    expect(useTreeStore.getState().zen).toBe(false);
    btn.click();
    expect(useTreeStore.getState().zen).toBe(true);
  });

  it("ZEN-SB-3: the zen button uses the accent color when zen is active (icon inherits via currentColor)", () => {
    useTreeStore.setState({ zen: true });
    renderStatusBar();
    const btn = screen.getByLabelText("Toggle zen mode");
    expect(btn.querySelector("svg")).not.toBeNull();
    expect((btn as HTMLButtonElement).style.color).toBe("var(--color-accent)");
  });

  it("ZEN-SB-4: the zen button uses the muted color when zen is inactive", () => {
    renderStatusBar();
    const btn = screen.getByLabelText("Toggle zen mode");
    expect(btn.querySelector("svg")).not.toBeNull();
    expect((btn as HTMLButtonElement).style.color).toBe("var(--color-muted)");
  });
});


describe("StatusBar — focused-note word count", () => {
  beforeEach(() => {
    useTreeStore.setState({ activeNoteId: null });
  });
  afterEach(() => {
    useTreeStore.setState({ activeNoteId: null });
    __resetAllControllersForTest();
  });

  it("SB-WC-1: renders no word count when no note is focused (blank state)", () => {
    renderStatusBar();
    expect(screen.queryByTestId("status-bar-word-count")).not.toBeInTheDocument();
  });

  it("SB-WC-2: renders the focused note's word count", () => {
    const noteId = "note-a";
    getOrCreateController(noteId).hydrate("one two three", "note-a.md");
    useTreeStore.setState({ activeNoteId: noteId });

    renderStatusBar();

    expect(screen.getByTestId("status-bar-word-count")).toHaveTextContent("3 words");
  });

  it("SB-WC-3: updates live as the focused pane's content changes", () => {
    const noteId = "note-a";
    const controller = getOrCreateController(noteId);
    controller.hydrate("one two", "note-a.md");
    useTreeStore.setState({ activeNoteId: noteId });

    renderStatusBar();
    expect(screen.getByTestId("status-bar-word-count")).toHaveTextContent("2 words");

    act(() => {
      controller.handleEditorChange("one two three four");
    });

    expect(screen.getByTestId("status-bar-word-count")).toHaveTextContent("4 words");
  });

  it("SB-WC-4: with two split panes open on different notes, reflects the FOCUSED pane's note — not a sum — and updates when focus switches", () => {
    const noteA = "note-a";
    const noteB = "note-b";
    const controllerA = getOrCreateController(noteA);
    const controllerB = getOrCreateController(noteB);
    controllerA.hydrate("alpha beta", "note-a.md"); // 2 words
    controllerB.hydrate("gamma delta epsilon four", "note-b.md"); // 4 words

    // Pane A is focused first.
    useTreeStore.setState({ activeNoteId: noteA });
    renderStatusBar();
    expect(screen.getByTestId("status-bar-word-count")).toHaveTextContent("2 words");

    // Focus switches to pane B (e.g. the user clicks into the split's other
    // pane) — the status bar must show B's count, NOT 2+4=6 (a sum).
    act(() => {
      useTreeStore.setState({ activeNoteId: noteB });
    });
    expect(screen.getByTestId("status-bar-word-count")).toHaveTextContent("4 words");

    // An edit in the now-unfocused pane A must NOT move the displayed count —
    // it stays pinned to the focused pane (B)'s live count.
    act(() => {
      controllerA.handleEditorChange("alpha beta gamma delta epsilon");
    });
    expect(screen.getByTestId("status-bar-word-count")).toHaveTextContent("4 words");

    // Switching focus back to A reflects A's (now-edited) count.
    act(() => {
      useTreeStore.setState({ activeNoteId: noteA });
    });
    expect(screen.getByTestId("status-bar-word-count")).toHaveTextContent("5 words");
  });
});
