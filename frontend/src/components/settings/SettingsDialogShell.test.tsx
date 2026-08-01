/**
 * SettingsDialogShell tests — the composed dialog frame, nav/pane wiring,
 * D-19 fixed geometry, D-20 always-opens-on-Appearance, and the shared
 * save-error banner. Per-section Reset orchestration is covered separately
 * once wired (a later commit in this plan).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../lib/useConfig";
import { TooltipProvider } from "../Tooltip";

const mockConfig = {
  appName: "Jasper",
  theme: "dark",
  accent: "purple",
  readingFont: "sans",
  dailyNotes: { template: "# {{date}}\n\n" },
  editor: {
    fontSize: 15,
    lineHeight: 1.45,
    autosaveMs: 2000,
    showProperties: true,
    autoPair: true,
    foldGutter: true,
    lineNumbers: false,
    lineWidth: 700,
  },
  server: { port: 6683, dataDir: "/vault", bind: "127.0.0.1" },
  mcp: { port: 6684, bind: "127.0.0.1", auditLog: false },
  templates: { folder: "Templates" },
};

vi.mock("../../api/client", () => ({
  client: {
    GET: vi.fn().mockResolvedValue({
      data: {
        appName: "Jasper",
        theme: "dark",
        accent: "purple",
        readingFont: "sans",
        dailyNotes: { template: "# {{date}}\n\n" },
        editor: {
          fontSize: 15,
          lineHeight: 1.45,
          autosaveMs: 2000,
          showProperties: true,
          autoPair: true,
          foldGutter: true,
          lineNumbers: false,
          lineWidth: 700,
        },
        server: { port: 6683, dataDir: "/vault", bind: "127.0.0.1" },
        mcp: { port: 6684, bind: "127.0.0.1", auditLog: false },
        templates: { folder: "Templates" },
      },
      response: { status: 200 },
    }),
    PUT: vi.fn(),
    PATCH: vi.fn(),
  },
}));

vi.mock("../../lib/vaultAboutApi", () => ({
  getVaultAbout: vi.fn().mockResolvedValue({
    data: {
      vaultName: "my-vault",
      noteCount: 3,
      folderCount: 1,
      path: "/vault",
      appVersion: "1.4.0",
      mcpPort: 6684,
      mcpGrantCount: 0,
    },
  }),
}));

vi.mock("../../lib/useReveal", () => ({
  useReveal: () => ({ reveal: vi.fn(), revealVaultRoot: vi.fn(), loading: false }),
}));

vi.mock("../toast.utils", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { client } from "../../api/client";
import { __testing__ as resourcesTesting } from "../../lib/resources/createResource";
import { __testing__ as configApiTesting } from "../../lib/configApi";
import { SettingsDialogShell } from "./SettingsDialogShell";

const mockClient = client as unknown as {
  GET: ReturnType<typeof vi.fn>;
  PUT: ReturnType<typeof vi.fn>;
  PATCH: ReturnType<typeof vi.fn>;
};

// Harness gives the test control over remounting the dialog open/closed —
// SettingsDialogShell.onOpenChange is the parent's setter, not a self-toggle.
function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <TooltipProvider>
      <button type="button" onClick={() => setOpen(true)}>
        test-reopen
      </button>
      <SettingsDialogShell open={open} onOpenChange={setOpen} />
    </TooltipProvider>
  );
}

// PaneHeader's Close button is Tooltip-wrapped (Phase 31 convention); the
// shell relies on App.tsx's app-root TooltipProvider in production, so tests
// supply their own ancestor.
function renderShell(props: Partial<React.ComponentProps<typeof SettingsDialogShell>> = {}) {
  return render(
    <TooltipProvider>
      <SettingsDialogShell open={true} onOpenChange={vi.fn()} {...props} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // configResource is a module-level, boot-scoped singleton (D-15) shared
  // by every useConfig() instance in this file's tests — without this
  // reset, a later test's mount reads a prior test's cached config instead
  // of issuing its own GET, breaking assertions like "GET still fires".
  resourcesTesting.reset();
  configApiTesting.reset();
  mockClient.GET.mockResolvedValue({ data: mockConfig, response: { status: 200 } });
  mockClient.PUT.mockImplementation((_path: string, opts: { body: unknown }) =>
    Promise.resolve({ data: opts.body, response: { status: 200 } }),
  );
  // Panes call saveConfig -> PATCH during shell tests (not exercised by the
  // per-section Reset tests below, which assert on PUT); an undefined
  // client.PATCH throws, so every shell test needs this wired.
  mockClient.PATCH.mockResolvedValue({ data: mockConfig, response: { status: 200 } });
});

describe("<SettingsDialogShell />", () => {
  it("opens on Appearance, and reopening after switching to Daily notes lands back on Appearance", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("Accent and typography")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Daily notes/ }));
    await waitFor(() => expect(screen.getByLabelText("Daily note template")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "test-reopen" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByText("Accent and typography")).toBeInTheDocument();
  });

  it("renders the NavColumn footer caption using GET /vault/about data (WR-01)", async () => {
    renderShell();
    await waitFor(() => expect(screen.getByText("Accent and typography")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("my-vault · v1.4.0")).toBeInTheDocument());
  });

  it("clicking each nav item swaps the pane content", async () => {
    renderShell();
    await waitFor(() => expect(screen.getByText("Accent and typography")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Editor/ }));
    await waitFor(() => expect(screen.getByLabelText("Autosave interval")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Daily notes/ }));
    await waitFor(() => expect(screen.getByLabelText("Daily note template")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /About/ }));
    await waitFor(() => expect(screen.getByText("Vault name")).toBeInTheDocument());
  });

  it("About renders no Reset button while Editor renders one (D-08)", async () => {
    renderShell();
    await waitFor(() => expect(screen.getByText("Accent and typography")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Editor/ }));
    await waitFor(() => expect(screen.getByLabelText("Autosave interval")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /About/ }));
    await waitFor(() => expect(screen.getByText("Vault name")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("does not render a dialog role when open=false (ported from SD-2)", async () => {
    renderShell({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
    // useConfig's GET still fires even while closed (the shell mounts a
    // single instance regardless of `open`) — let it settle so the
    // subsequent state update doesn't leak into the next test's act scope.
    await waitFor(() => expect(mockClient.GET).toHaveBeenCalled());
  });

  it("renders no Save button anywhere in the dialog (ported: auto-persist, no Save button)", async () => {
    renderShell();
    await waitFor(() => expect(screen.getByText("Accent and typography")).toBeInTheDocument());
    const saveButtons = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.toLowerCase().includes("save"));
    expect(saveButtons).toHaveLength(0);
  });

  it("the Dialog.Content inline width/height stay 920/628 across a section switch", async () => {
    renderShell();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    const dialogEl = screen.getByRole("dialog");
    expect(dialogEl).toHaveStyle({ width: "920px", height: "628px" });

    fireEvent.click(screen.getByRole("button", { name: /Daily notes/ }));
    await waitFor(() => expect(screen.getByLabelText("Daily note template")).toBeInTheDocument());
    expect(dialogEl).toHaveStyle({ width: "920px", height: "628px" });
  });

  it("opening Settings logs no console warning, and the description resolves to a real element (32-REVIEW WR-04)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      renderShell();
      await waitFor(() => expect(screen.getByText("Accent and typography")).toBeInTheDocument());

      const descId = screen.getByRole("dialog").getAttribute("aria-describedby");
      expect(descId).toBeTruthy();
      expect(document.getElementById(descId!)).toHaveTextContent(
        "Change application settings",
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("the scroll container carries minHeight: 0", () => {
    // Source-level assertion, matching the plan's own acceptance grep.
    const src = readFileSync(
      join(process.cwd(), "src/components/settings/SettingsDialogShell.tsx"),
      "utf-8",
    );
    expect((src.match(/minHeight: 0/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("renders exactly one save-error banner when a pane reports an error, and it dismisses", async () => {
    // Panes call saveConfig -> PATCH (D-05); Reset is the only PUT caller.
    mockClient.PATCH.mockResolvedValueOnce({
      error: { code: "invalid_request", message: "offline" },
      response: { status: 400 },
    });

    renderShell();
    await waitFor(() => expect(screen.getByText("Accent and typography")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Daily notes/ }));
    const templateInput = await screen.findByLabelText("Daily note template");
    fireEvent.change(templateInput, { target: { value: "## journal" } });
    fireEvent.blur(templateInput);

    await waitFor(() => {
      expect(screen.getAllByRole("alert")).toHaveLength(1);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("offline");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("clears a stale save-error banner on close so a still-mounted reopen starts clean (32-REVIEW IN-03)", async () => {
    // Panes call saveConfig -> PATCH (D-05); Reset is the only PUT caller.
    mockClient.PATCH.mockResolvedValueOnce({
      error: { code: "invalid_request", message: "offline" },
      response: { status: 400 },
    });

    // Harness keeps the shell mounted across close, matching SettingsMenu's
    // entry point (ActivityRibbon unmounts instead).
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("Accent and typography")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Daily notes/ }));
    const templateInput = await screen.findByLabelText("Daily note template");
    fireEvent.change(templateInput, { target: { value: "## journal" } });
    fireEvent.blur(templateInput);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("offline"));

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "test-reopen" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("per-section Reset", () => {
    it("Editor: Cancel calls saveConfig 0 times", async () => {
      renderShell();
      fireEvent.click(screen.getByRole("button", { name: /Editor/ }));
      await screen.findByLabelText("Autosave interval");

      fireEvent.click(screen.getByRole("button", { name: "Reset" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(within(dialog).getByText("Reset Editor to defaults?")).toBeInTheDocument();

      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(mockClient.PUT).not.toHaveBeenCalled();
    });

    it("Editor: confirming resets only autosaveMs, in exactly one saveConfig call", async () => {
      renderShell();
      fireEvent.click(screen.getByRole("button", { name: /Editor/ }));
      await screen.findByLabelText("Autosave interval");

      fireEvent.click(screen.getByRole("button", { name: "Reset" }));
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));

      await waitFor(() => expect(mockClient.PUT).toHaveBeenCalledTimes(1));
      const saved = mockClient.PUT.mock.calls[0][1].body as Config;
      expect(saved.editor.autosaveMs).toBe(2000); // DEFAULT_CONFIG.editor.autosaveMs
      expect(saved.editor.fontSize).toBe(mockConfig.editor.fontSize);
      expect(saved.editor.lineHeight).toBe(mockConfig.editor.lineHeight);
      expect(saved.accent).toBe(mockConfig.accent);
      expect(saved.dailyNotes).toEqual(mockConfig.dailyNotes);
      expect(saved.server).toEqual(mockConfig.server);
      // Reset must not fan out into a PATCH — it stays on the PUT verb (D-07).
      expect(mockClient.PATCH).not.toHaveBeenCalled();
    });

    // The pane-header Reset is the ONLY reset affordance for this pane since
    // the inline "Reset to default" link was dropped (IN-02), so this is the
    // sole assertion that a dailyNotes reset writes the exact default string.
    it("Daily notes: confirming resets only dailyNotes.template to the exact default", async () => {
      renderShell();
      fireEvent.click(screen.getByRole("button", { name: /Daily notes/ }));
      await screen.findByLabelText("Daily note template");

      fireEvent.click(screen.getByRole("button", { name: "Reset" }));
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));

      await waitFor(() => expect(mockClient.PUT).toHaveBeenCalledTimes(1));
      const saved = mockClient.PUT.mock.calls[0][1].body as Config;
      expect(saved.dailyNotes.template).toBe("# {{date}}\n\n"); // DEFAULT_CONFIG.dailyNotes.template
      expect(saved.editor).toEqual(mockConfig.editor);
      expect(saved.accent).toBe(mockConfig.accent);
      expect(saved.server).toEqual(mockConfig.server);
      expect(mockClient.PATCH).not.toHaveBeenCalled();
    });

    it("Appearance: one saveConfig call carries accent, readingFont, fontSize, and lineHeight; autosaveMs untouched", async () => {
      renderShell();
      await screen.findByText("Accent and typography");

      fireEvent.click(screen.getByRole("button", { name: "Reset" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(within(dialog).getByText("Reset Appearance to defaults?")).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));

      await waitFor(() => expect(mockClient.PUT).toHaveBeenCalledTimes(1));
      const saved = mockClient.PUT.mock.calls[0][1].body as Config;
      expect(saved.accent).toBe("purple"); // DEFAULT_CONFIG.accent
      expect(saved.readingFont).toBe("sans"); // DEFAULT_CONFIG.readingFont
      expect(saved.editor.fontSize).toBe(15); // DEFAULT_CONFIG.editor.fontSize
      expect(saved.editor.lineHeight).toBe(1.45); // DEFAULT_CONFIG.editor.lineHeight
      expect(saved.editor.autosaveMs).toBe(mockConfig.editor.autosaveMs);

      await waitFor(() => {
        expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("15px");
        expect(document.documentElement.style.getPropertyValue("--editor-line-height")).toBe(
          "1.45",
        );
      });
    });

    it("a failing reset renders the save-error banner", async () => {
      mockClient.PUT.mockResolvedValueOnce({
        error: { code: "invalid_request", message: "disk full" },
        response: { status: 500 },
      });

      renderShell();
      fireEvent.click(screen.getByRole("button", { name: /Editor/ }));
      await screen.findByLabelText("Autosave interval");

      fireEvent.click(screen.getByRole("button", { name: "Reset" }));
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("disk full");
      });
    });
  });
});
