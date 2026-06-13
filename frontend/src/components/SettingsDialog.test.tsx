/**
 * SettingsDialog component tests — Phase 11 Plan 03 (SET-01/02/04/06).
 *
 * SD-1: renders Dialog.Title "Settings" when open=true
 * SD-2: dialog does NOT render when open=false
 * SD-3: Close button calls onOpenChange(false)
 * SD-4: all four section eyebrows present (APPEARANCE/EDITOR/DAILY NOTES/GENERAL)
 * SD-5 (SET-04): blurring "Editor font size" input sets --editor-font-size CSS var
 * SD-6 (SET-06): ≥2 elements with aria-label "Requires reload to apply"
 * + line height CSS var on blur
 * + out-of-range revert for font size
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the API client — same pattern as SettingsMenu.test.tsx
vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn().mockResolvedValue({
      data: {
        appName: "Jasper",
        display_name: "My Notes",
        theme: "dark",
        dailyNotes: { folder: "daily", template: "# {{date}}\n\n" },
        editor: { fontSize: 15, lineHeight: 1.6, vimMode: false, autosaveMs: 2000 },
      },
      response: { status: 200 },
    }),
    PUT: vi.fn().mockResolvedValue({ data: {
      appName: "Jasper",
      display_name: "My Notes",
      theme: "dark",
      dailyNotes: { folder: "daily", template: "# {{date}}\n\n" },
      editor: { fontSize: 15, lineHeight: 1.6, vimMode: false, autosaveMs: 2000 },
    }, response: { status: 200 } }),
  },
}));

import { SettingsDialog } from "./SettingsDialog";

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--editor-font-size");
  document.documentElement.style.removeProperty("--editor-line-height");
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

  it("SD-4: APPEARANCE, EDITOR, DAILY NOTES, GENERAL eyebrows all present", async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("APPEARANCE")).toBeInTheDocument();
      expect(screen.getByText("EDITOR")).toBeInTheDocument();
      expect(screen.getByText("DAILY NOTES")).toBeInTheDocument();
      expect(screen.getByText("GENERAL")).toBeInTheDocument();
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
    // input should revert to config value
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
    // Only Close button, no Save
    const buttons = screen.getAllByRole("button");
    const saveButtons = buttons.filter((b) => b.textContent?.toLowerCase().includes("save"));
    expect(saveButtons.length).toBe(0);
  });
});
