/**
 * SettingsDialog component tests.
 *
 * SD-1: renders Dialog.Title "Settings" when open=true
 * SD-2: dialog does NOT render when open=false
 * SD-3: Close button calls onOpenChange(false)
 * SD-4: all five section eyebrows present (APPEARANCE/EDITOR/DAILY NOTES/GENERAL/NETWORK)
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

// Mock the API client — same pattern as SettingsMenu.test.tsx
vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn().mockResolvedValue({
      data: {
        appName: "Jasper",
        display_name: "My Notes",
        theme: "dark",
        accent: "purple",
        readingFont: "sans",
        dailyNotes: { folder: "daily", template: "# {{date}}\n\n" },
        editor: { fontSize: 15, lineHeight: 1.6, vimMode: false, autosaveMs: 2000 },
        server: { port: 6683, dataDir: "/home/user/.jasper", bind: "127.0.0.1" },
      },
      response: { status: 200 },
    }),
    PUT: vi.fn().mockResolvedValue({
      data: {
        appName: "Jasper",
        display_name: "My Notes",
        theme: "dark",
        accent: "purple",
        readingFont: "sans",
        dailyNotes: { folder: "daily", template: "# {{date}}\n\n" },
        editor: { fontSize: 15, lineHeight: 1.6, vimMode: false, autosaveMs: 2000 },
        server: { port: 6683, dataDir: "/home/user/.jasper", bind: "127.0.0.1" },
      },
      response: { status: 200 },
    }),
  },
}));

// Base config shape reused across tests (must match the mock above)
const baseMockConfig = {
  appName: "Jasper",
  display_name: "My Notes",
  theme: "dark",
  accent: "purple",
  readingFont: "sans",
  dailyNotes: { folder: "daily", template: "# {{date}}\n\n" },
  editor: { fontSize: 15, lineHeight: 1.6, vimMode: false, autosaveMs: 2000 },
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

  it("SD-3: Close button calls onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    render(<SettingsDialog open={true} onOpenChange={onOpenChange} />);
    await waitFor(() => screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("SD-4: APPEARANCE, EDITOR, DAILY NOTES, GENERAL, NETWORK eyebrows all present", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("APPEARANCE")).toBeInTheDocument();
      expect(screen.getByText("EDITOR")).toBeInTheDocument();
      expect(screen.getByText("DAILY NOTES")).toBeInTheDocument();
      expect(screen.getByText("GENERAL")).toBeInTheDocument();
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

  it("SD-6 (SET-06): ≥2 elements with aria-label 'Requires reload to apply'", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => {
      const badges = screen.getAllByLabelText("Requires reload to apply");
      expect(badges.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("honest vim copy: 'not yet active' text is present", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/not yet active/i)).toBeInTheDocument();
    });
  });

  it("no Save button rendered", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => screen.getByRole("button", { name: "Close" }));
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
});
