import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Config, ConfigPatch } from "../../lib/useConfig";
import { EditorSection } from "./EditorSection";

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
  render(<EditorSection config={config} saveConfig={saveConfig} onSaveError={onSaveError} />);
  return { saveConfig, onSaveError };
}

describe("EditorSection", () => {
  it("renders the autosave input with the current config value", () => {
    renderSection(makeConfig({ editor: { ...makeConfig().editor, autosaveMs: 4500 } }));
    expect(screen.getByLabelText("Autosave interval")).toHaveValue(4500);
  });

  it("commits a bare { editor: { autosaveMs } } partial on blur", async () => {
    const config = makeConfig();
    const { saveConfig } = renderSection(config);
    const input = screen.getByLabelText("Autosave interval");
    fireEvent.change(input, { target: { value: "3000" } });
    fireEvent.blur(input);

    expect(saveConfig).toHaveBeenCalledTimes(1);
    const saved = saveConfig.mock.calls[0][0] as ConfigPatch;
    expect(Object.keys(saved)).toEqual(["editor"]);
    expect(Object.keys(saved.editor!)).toEqual(["autosaveMs"]);
    expect(saved.editor?.autosaveMs).toBe(3000);
  });

  it("rejects an out-of-range value, reverts, and never calls saveConfig", async () => {
    const config = makeConfig();
    const { saveConfig } = renderSection(config);
    const input = screen.getByLabelText("Autosave interval");
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.blur(input);

    expect(saveConfig).toHaveBeenCalledTimes(0);
    expect(await screen.findByRole("alert")).toHaveTextContent(/between 250 and 10000/i);
    expect(input).toHaveValue(config.editor.autosaveMs);
  });

  it("blurring the autosave input with the current (valid, unchanged) value calls saveConfig zero times", () => {
    const config = makeConfig();
    const { saveConfig } = renderSection(config);
    const input = screen.getByLabelText("Autosave interval");
    fireEvent.change(input, { target: { value: String(config.editor.autosaveMs) } });
    fireEvent.blur(input);

    expect(saveConfig).toHaveBeenCalledTimes(0);
  });

  it("renders no control for auto-pair, fold, line numbers, line width, or properties", () => {
    renderSection(makeConfig());
    expect(
      screen.queryByRole("checkbox", { name: /auto.?pair|fold|line numbers|properties/i }),
    ).toBeNull();
    expect(screen.queryByRole("textbox", { name: /line width/i })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: /line width|properties/i })).toBeNull();
  });
});
