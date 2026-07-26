import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../lib/useConfig";
import { DailyNotesSection } from "./DailyNotesSection";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    appName: "Jasper",
    theme: "dark",
    accent: "purple",
    readingFont: "sans",
    dailyNotes: { folder: "daily", template: "# {{date}}\n\n" },
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
  it("renders the folder input with the config value and commits on blur, preserving the template", async () => {
    const config = makeConfig({ dailyNotes: { folder: "journal", template: "custom template" } });
    const { saveConfig } = renderSection(config);
    const folderInput = screen.getByLabelText("Daily notes folder");
    expect(folderInput).toHaveValue("journal");

    fireEvent.change(folderInput, { target: { value: "logs" } });
    fireEvent.blur(folderInput);

    expect(saveConfig).toHaveBeenCalledTimes(1);
    const saved = saveConfig.mock.calls[0][0] as Config;
    expect(saved.dailyNotes.folder).toBe("logs");
    expect(saved.dailyNotes.template).toBe("custom template");
  });

  it("commits the template textarea on blur", async () => {
    const config = makeConfig();
    const { saveConfig } = renderSection(config);
    const textarea = screen.getByLabelText("Daily note template");

    fireEvent.change(textarea, { target: { value: "## {{date}}\n" } });
    fireEvent.blur(textarea);

    expect(saveConfig).toHaveBeenCalledTimes(1);
    const saved = saveConfig.mock.calls[0][0] as Config;
    expect(saved.dailyNotes.template).toBe("## {{date}}\n");
  });

  it("resets the template to the exact default string and calls saveConfig once", async () => {
    const config = makeConfig({ dailyNotes: { folder: "daily", template: "something else" } });
    const { saveConfig } = renderSection(config);

    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));

    expect(saveConfig).toHaveBeenCalledTimes(1);
    const saved = saveConfig.mock.calls[0][0] as Config;
    expect(saved.dailyNotes.template).toBe("# {{date}}\n\n");
  });

  it("surfaces a rejected saveConfig through onSaveError", async () => {
    const config = makeConfig();
    const saveConfig = vi.fn().mockResolvedValue({ error: { code: "bad", message: "nope", status: 400 } });
    const { onSaveError } = renderSection(config, saveConfig);
    const folderInput = screen.getByLabelText("Daily notes folder");

    fireEvent.change(folderInput, { target: { value: "logs" } });
    fireEvent.blur(folderInput);

    await vi.waitFor(() => {
      expect(onSaveError).toHaveBeenCalledWith("nope");
    });
  });
});
