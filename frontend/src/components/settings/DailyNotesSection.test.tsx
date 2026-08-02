import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Config, ConfigPatch } from "../../lib/useConfig";
import { DailyNotesSection } from "./DailyNotesSection";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    appName: "Jasper",
    theme: "dark",
    accent: "purple",
    readingFont: "sans",
    dailyNotes: { template: "# {{date}}\n\n" },
    editor: {
      fontSize: 15,
      lineHeight: 1.6,
      autosaveMs: 2000,
      showProperties: true,
      autoPair: true,
      foldGutter: true,
      lineNumbers: false,
      lineWidth: 700,
    },
    ...overrides,
  } as Config;
}

function renderSection(config: Config, saveConfig = vi.fn().mockResolvedValue({})) {
  const onSaveError = vi.fn();
  render(<DailyNotesSection config={config} saveConfig={saveConfig} onSaveError={onSaveError} />);
  return { saveConfig, onSaveError };
}

describe("DailyNotesSection", () => {
  it("commits a bare { dailyNotes: { template } } partial on blur", async () => {
    const config = makeConfig();
    const { saveConfig } = renderSection(config);
    const textarea = screen.getByLabelText("Daily note template");

    fireEvent.change(textarea, { target: { value: "## {{date}}\n" } });
    fireEvent.blur(textarea);

    expect(saveConfig).toHaveBeenCalledTimes(1);
    const saved = saveConfig.mock.calls[0][0] as ConfigPatch;
    expect(Object.keys(saved)).toEqual(["dailyNotes"]);
    expect(Object.keys(saved.dailyNotes!)).toEqual(["template"]);
    expect(saved.dailyNotes?.template).toBe("## {{date}}\n");
  });

  it("blurring the template textarea without editing it calls saveConfig zero times", () => {
    const config = makeConfig();
    const { saveConfig } = renderSection(config);
    const textarea = screen.getByLabelText("Daily note template");

    fireEvent.focus(textarea);
    fireEvent.blur(textarea);

    expect(saveConfig).toHaveBeenCalledTimes(0);
  });

  // Owner feedback (2026-07-30): the inline link duplicated the pane-header
  // Reset, which writes the identical patch. The surviving affordance is
  // covered by SettingsDialogShell.test.tsx "Daily notes: confirming resets
  // only dailyNotes.template to the exact default".
  it("renders no inline reset affordance — the pane-header Reset is the only one", () => {
    const config = makeConfig({ dailyNotes: { template: "something else" } });
    const { saveConfig } = renderSection(config);

    expect(screen.queryByRole("button", { name: /reset/i })).toBeNull();
    expect(screen.queryByText(/reset to default/i)).toBeNull();
    expect(saveConfig).toHaveBeenCalledTimes(0);
  });

  it("surfaces a rejected saveConfig through onSaveError", async () => {
    const config = makeConfig();
    const saveConfig = vi.fn().mockResolvedValue({ error: { code: "bad", message: "nope", status: 400 } });
    const { onSaveError } = renderSection(config, saveConfig);
    const textarea = screen.getByLabelText("Daily note template");

    fireEvent.change(textarea, { target: { value: "## journal" } });
    fireEvent.blur(textarea);

    await vi.waitFor(() => {
      expect(onSaveError).toHaveBeenCalledWith("nope");
    });
  });
});
