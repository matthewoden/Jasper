/**
 * SettingsDialog component tests.
 *
 * SD-1: renders Dialog.Title "Settings" when open=true
 * SD-2: dialog does NOT render when open=false
 * SD-3: Close button calls onOpenChange(false)
 * SD-4: all four section eyebrows present (APPEARANCE/EDITOR/DAILY NOTES/NETWORK)
 * SD-5: blurring "Editor font size" input sets --editor-font-size CSS var
 * SD-6: ≥2 elements with aria-label "Requires reload to apply"
 * SD-7: four accent swatches present with correct aria-labels
 * SD-8: clicking Sky swatch calls setAccent/saveConfig with accent "sky"
 * SD-9: reading font group present; clicking Serif persists readingFont "serif"
 * NET-01a: blurring bind address input calls saveConfig with server.bind set to new value
 * NET-01b: warning banner present for 0.0.0.0, absent for 127.0.0.1
 */
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const testEditorConfig = {
  fontSize: 15,
  lineHeight: 1.6,
  autosaveMs: 2000,
  showProperties: true,
  autoPair: true,
  foldGutter: true,
  lineNumbers: false,
  lineWidth: 700,
};

// Mock the API client — same pattern as SettingsMenu.test.tsx
vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn().mockResolvedValue({
      data: {
        appName: "Jasper",
        theme: "dark",
        accent: "purple",
        readingFont: "sans",
        dailyNotes: { folder: "daily", template: "# {{date}}\n\n" },
        editor: { fontSize: 15, lineHeight: 1.6, autosaveMs: 2000, showProperties: true, autoPair: true, foldGutter: true, lineNumbers: false, lineWidth: 700 },
        server: { port: 6683, dataDir: "/home/user/.jasper", bind: "127.0.0.1" },
      },
      response: { status: 200 },
    }),
    PUT: vi.fn().mockResolvedValue({
      data: {
        appName: "Jasper",
        theme: "dark",
        accent: "purple",
        readingFont: "sans",
        dailyNotes: { folder: "daily", template: "# {{date}}\n\n" },
        editor: { fontSize: 15, lineHeight: 1.6, autosaveMs: 2000, showProperties: true, autoPair: true, foldGutter: true, lineNumbers: false, lineWidth: 700 },
        server: { port: 6683, dataDir: "/home/user/.jasper", bind: "127.0.0.1" },
      },
      response: { status: 200 },
    }),
  },
}));

// Base config shape reused across tests (must match the mock above)
const baseMockConfig = {
  appName: "Jasper",
  theme: "dark",
  accent: "purple",
  readingFont: "sans",
  dailyNotes: { folder: "daily", template: "# {{date}}\n\n" },
  editor: testEditorConfig,
  server: { port: 6683, dataDir: "/home/user/.jasper", bind: "127.0.0.1" },
};

import { client } from "../api/client";
const mockClient = client as unknown as {
  GET: ReturnType<typeof vi.fn>;
  PUT: ReturnType<typeof vi.fn>;
};

import { SettingsDialog } from "./SettingsDialog";

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--editor-font-size");
  document.documentElement.style.removeProperty("--editor-line-height");
  document.documentElement.style.removeProperty("--color-accent");
  document.documentElement.style.removeProperty("--font-reading");
  vi.clearAllMocks();
});

describe("<SettingsDialog />", () => {
  it("SD-1: renders title 'Settings' when open=true", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
  });

  it("SD-2: dialog does NOT render when open=false", () => {
    render(<SettingsDialog open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("SD-3: Done button calls onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    render(<SettingsDialog open={true} onOpenChange={onOpenChange} />);
    await waitFor(() => screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("SD-4: APPEARANCE, EDITOR, DAILY NOTES, NETWORK eyebrows all present", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("APPEARANCE")).toBeInTheDocument();
      expect(screen.getByText("EDITOR")).toBeInTheDocument();
      expect(screen.getByText("DAILY NOTES")).toBeInTheDocument();
      expect(screen.getByText("NETWORK")).toBeInTheDocument();
    });
  });

  it("SD-5 (SET-04): blurring Editor font size input sets --editor-font-size CSS var", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => screen.getByLabelText("Editor font size"));
    const input = screen.getByLabelText("Editor font size");
    fireEvent.change(input, { target: { value: "18" } });
    fireEvent.blur(input);
    expect(
      document.documentElement.style.getPropertyValue("--editor-font-size"),
    ).toBe("18px");
  });

  it("SET-04: blurring Editor line height input sets --editor-line-height CSS var", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => screen.getByLabelText("Editor line height"));
    const input = screen.getByLabelText("Editor line height");
    fireEvent.change(input, { target: { value: "1.8" } });
    fireEvent.blur(input);
    expect(
      document.documentElement.style.getPropertyValue("--editor-line-height"),
    ).toBe("1.8");
  });

  it("out-of-range font size on blur shows error and reverts", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => screen.getByLabelText("Editor font size"));
    const input = screen.getByLabelText("Editor font size");
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect((input as HTMLInputElement).value).toBe("15");
  });

  it("SD-6 (SET-06): restart badge appears after changing a restart-pending field", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => screen.getByLabelText("Autosave interval"));

    // No badge on first open — deferred against boot baseline (SET2-03)
    expect(screen.queryAllByLabelText("Requires reload to apply")).toHaveLength(0);

    // Changing a restart-pending field triggers the badge
    const autosaveInput = screen.getByLabelText("Autosave interval");
    fireEvent.change(autosaveInput, { target: { value: "5000" } });

    await waitFor(() => {
      const badges = screen.queryAllByLabelText("Requires reload to apply");
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("D-04/D-05: Vim mode and Display name controls are absent (deleted, not hidden)", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => screen.getByText("NETWORK"));
    expect(screen.queryByLabelText("Vim mode")).toBeNull();
    expect(screen.queryByLabelText("Display name")).toBeNull();
  });

  it("no Save button rendered", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => screen.getByRole("button", { name: "Done" }));
    const buttons = screen.getAllByRole("button");
    const saveButtons = buttons.filter((b) => b.textContent?.toLowerCase().includes("save"));
    expect(saveButtons.length).toBe(0);
  });

  it("CR-03b/WR-04: save failure shows error banner and reverts input", async () => {
    // Make PUT fail after initial load
    mockClient.PUT.mockResolvedValueOnce({
      error: { code: "invalid_request", message: "server side error" },
      response: { status: 400 },
    });

    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => screen.getByLabelText("Editor font size"));

    const input = screen.getByLabelText("Editor font size");
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.blur(input);

    // Error banner should appear (may be multiple alerts: per-field + global save banner)
    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(alerts.length).toBeGreaterThan(0);
    });
    // At least one alert must mention the server error
    const alerts = screen.getAllByRole("alert");
    const mentionsError = alerts.some(a => /server side error/i.test(a.textContent ?? ""));
    expect(mentionsError).toBe(true);
  });

  it("CR-03a: line height values between 2.5 and 3.0 are accepted (not rejected)", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => screen.getByLabelText("Editor line height"));

    const input = screen.getByLabelText("Editor line height");
    fireEvent.change(input, { target: { value: "2.8" } });
    fireEvent.blur(input);

    // Should NOT show a validation error for 2.8 (within 1.0–3.0)
    // (no role="alert" from the lineHeightError state)
    await waitFor(() => {
      const alerts = screen.queryAllByRole("alert");
      const lineHeightAlerts = alerts.filter(a => a.textContent?.includes("3.0") || a.textContent?.includes("2.5"));
      expect(lineHeightAlerts.length).toBe(0);
    });
  });

  it("SD-7: four accent swatches with aria-labels Purple/Sky/Green/Orange", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByLabelText("Purple")).toBeInTheDocument();
      expect(screen.getByLabelText("Sky")).toBeInTheDocument();
      expect(screen.getByLabelText("Green")).toBeInTheDocument();
      expect(screen.getByLabelText("Orange")).toBeInTheDocument();
    });
  });

  it("SD-8: clicking Sky swatch calls saveConfig with accent 'sky' and applies --color-accent", async () => {
    mockClient.PUT.mockResolvedValue({
      data: { ...baseMockConfig, accent: "sky" },
      response: { status: 200 },
    });

    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);

    // Wait for config to load and accent to be synced to DOM
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#a78bfa"),
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Sky"));
    });

    // --color-accent should be sky hex immediately (optimistic)
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#7dd3fc");

    // saveConfig (PUT) should have been called with accent: "sky"
    await waitFor(() => {
      expect(mockClient.PUT).toHaveBeenCalled();
    });
    const putBody = mockClient.PUT.mock.calls[0][1]?.body as { accent?: string };
    expect(putBody?.accent).toBe("sky");
  });

  it("SD-9: reading font group present; clicking Serif persists readingFont 'serif'", async () => {
    mockClient.PUT.mockResolvedValue({
      data: { ...baseMockConfig, readingFont: "serif" },
      response: { status: 200 },
    });

    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);

    // Wait for the reading font group to appear
    await waitFor(() => screen.getByRole("group", { name: "Reading font" }));

    const serifButton = screen.getByRole("button", { name: "Serif" });
    await act(async () => {
      fireEvent.click(serifButton);
    });

    await waitFor(() => {
      expect(mockClient.PUT).toHaveBeenCalled();
    });
    const putBody = mockClient.PUT.mock.calls[0][1]?.body as { readingFont?: string };
    expect(putBody?.readingFont).toBe("serif");
  });

  it("NET-01a: blurring bind address input calls saveConfig with server.bind set to new value", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => screen.getByLabelText("Bind address"));

    const input = screen.getByLabelText("Bind address");
    fireEvent.change(input, { target: { value: "0.0.0.0" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockClient.PUT).toHaveBeenCalled();
    });

    const putBody = mockClient.PUT.mock.calls[0][1]?.body as { server?: { bind?: string } };
    expect(putBody?.server?.bind).toBe("0.0.0.0");
  });

  it("NET-01b: warning banner present for 0.0.0.0, absent for 127.0.0.1", async () => {
    // Render with 0.0.0.0 config — warning banner should appear
    mockClient.GET.mockResolvedValueOnce({
      data: { ...baseMockConfig, server: { port: 6683, dataDir: "/home/user/.jasper", bind: "0.0.0.0" } },
      response: { status: 200 },
    });

    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      const warning = alerts.find(a =>
        a.textContent?.includes("Jasper is exposed on all network interfaces")
      );
      expect(warning).toBeDefined();
    });
  });

  it("NET-01b: warning banner absent for 127.0.0.1 (loopback)", async () => {
    // Default mock config has server.bind: "127.0.0.1" — no warning expected
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => screen.getByText("NETWORK"));

    const alerts = screen.queryAllByRole("alert");
    const warning = alerts.find(a =>
      a.textContent?.includes("Jasper is exposed on all network interfaces")
    );
    expect(warning).toBeUndefined();
  });

  // ─── SET2-02: inline font-size / line-height row ─────────────────────────
  //
  // RED scaffold: both inputs currently live in SEPARATE ControlRow elements.
  // After plan 02 lands, they must share a single combined ControlRow container.
  // Do NOT edit these tests to make them pass — fix the production component.

  describe("SET2-02: inline font-size / line-height row", () => {
    it("SET2-02: both #settings-font-size and #settings-line-height inputs exist", async () => {
      render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
      await waitFor(() => screen.getByLabelText("Editor font size"));
      expect(document.getElementById("settings-font-size")).not.toBeNull();
      expect(document.getElementById("settings-line-height")).not.toBeNull();
    });

    it("SET2-02: both inputs share a single ControlRow container (inline-row parent)", async () => {
      render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
      await waitFor(() => screen.getByLabelText("Editor font size"));

      const fontSizeInput = document.getElementById("settings-font-size");
      const lineHeightInput = document.getElementById("settings-line-height");
      expect(fontSizeInput).not.toBeNull();
      expect(lineHeightInput).not.toBeNull();

      // The label for settings-font-size should be the ControlRow label for the
      // combined row. Its parentElement is the outer ControlRow div.
      // After plan 02 fix: that div ALSO contains #settings-line-height.
      // RED now: lineHeightInput is in a separate ControlRow (different parent).
      const fontSizeLabel = document.querySelector('label[for="settings-font-size"]');
      expect(fontSizeLabel).not.toBeNull();
      const rowContainer = fontSizeLabel?.parentElement;

      expect(rowContainer?.contains(lineHeightInput)).toBe(true);
    });
  });

  // ─── SET2-03: deferred restart badge ─────────────────────────────────────
  //
  // Badge is deferred: only shown for autosaveMs and bind when the field
  // differs from the boot-baseline config captured at first load (D-05
  // honest-signal rule). Vim mode is deleted (D-04) and no longer contributes
  // a badge.

  describe("SET2-03: deferred restart badge (boot baseline)", () => {
    it("SET2-03: no restart badge shown on first open (badge deferred against boot baseline)", async () => {
      render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
      await waitFor(() => screen.getByLabelText("Autosave interval"));

      // Both badges (autosaveMs, bind) are deferred; 0 shown until user changes a field.
      expect(screen.queryAllByLabelText("Requires reload to apply")).toHaveLength(0);
    });

    it("SET2-03: badge appears after autosaveMs change and persists after blur/save settles", async () => {
      // PUT returns the changed autosaveMs so the badge has a real diff to show
      mockClient.PUT.mockResolvedValue({
        data: { ...baseMockConfig, editor: { ...baseMockConfig.editor, autosaveMs: 3000 } },
        response: { status: 200 },
      });

      render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
      await waitFor(() => screen.getByLabelText("Autosave interval"));

      // Initially: no badge (deferred against boot baseline)
      expect(screen.queryAllByLabelText("Requires reload to apply")).toHaveLength(0);

      // Change autosaveMs to a value that differs from boot baseline (2000 ms)
      const autosaveInput = screen.getByLabelText("Autosave interval");
      fireEvent.change(autosaveInput, { target: { value: "3000" } });

      // Badge must appear — field now differs from boot baseline
      expect(screen.queryAllByLabelText("Requires reload to apply")).not.toHaveLength(0);

      // Blur triggers saveConfig; response confirms autosaveMs=3000
      fireEvent.blur(autosaveInput);
      await waitFor(() => expect(mockClient.PUT).toHaveBeenCalled());

      // Badge MUST PERSIST after save — boot baseline still holds 2000 ms.
      // Only a page reload would reset the baseline (D-05).
      expect(screen.queryAllByLabelText("Requires reload to apply")).not.toHaveLength(0);
    });
  });

  // ─── SET2-04: reading-font live preview ──────────────────────────────────
  //
  // RED scaffold: no preview paragraph exists below the reading-font toggle.
  // After plan 02, a <p style="font-family: var(--font-reading)"> renders
  // below the Sans/Serif pill group and updates on toggle.

  describe("SET2-04: reading-font live preview paragraph", () => {
    it("SET2-04: a preview paragraph with var(--font-reading) font-family exists", async () => {
      render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
      await waitFor(() => screen.getByRole("group", { name: "Reading font" }));

      // RED: currently no preview paragraph below the reading-font toggle.
      // After fix: a <p style="...font-family: var(--font-reading)..."> is rendered.
      const previewParagraph = document.querySelector('p[style*="--font-reading"]');
      expect(previewParagraph).not.toBeNull();
    });

    it("SET2-04: preview paragraph is still present after toggling to Serif", async () => {
      mockClient.PUT.mockResolvedValue({
        data: { ...baseMockConfig, readingFont: "serif" },
        response: { status: 200 },
      });

      render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
      await waitFor(() => screen.getByRole("group", { name: "Reading font" }));

      fireEvent.click(screen.getByRole("button", { name: "Serif" }));

      // RED: currently no preview paragraph at all
      const preview = document.querySelector('p[style*="--font-reading"]');
      expect(preview).not.toBeNull();
    });
  });
});
