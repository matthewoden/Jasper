import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../lib/useConfig";

vi.mock("../../lib/useAccent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/useAccent")>();
  return {
    ...actual,
    useAccent: vi.fn(actual.useAccent),
    applyAccent: vi.fn(actual.applyAccent),
    persistAccentBootstrap: vi.fn(actual.persistAccentBootstrap),
    applyReadingFont: vi.fn(actual.applyReadingFont),
    persistReadingFontBootstrap: vi.fn(actual.persistReadingFontBootstrap),
  };
});

import { AppearanceSection } from "./AppearanceSection";
import {
  applyAccent,
  applyReadingFont,
  persistAccentBootstrap,
  persistReadingFontBootstrap,
  useAccent,
} from "../../lib/useAccent";

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
    server: { port: 6683, dataDir: "/vault", bind: "127.0.0.1" },
    mcp: { port: 6684, bind: "127.0.0.1", auditLog: false },
    ...overrides,
  } as Config;
}

function renderSection(config: Config, saveConfig = vi.fn().mockResolvedValue({})) {
  const onSaveError = vi.fn();
  render(<AppearanceSection config={config} saveConfig={saveConfig} onSaveError={onSaveError} />);
  return { saveConfig, onSaveError };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.style.cssText = "";
});

describe("AppearanceSection", () => {
  it("renders four accent swatches with the correct accessible names", () => {
    renderSection(makeConfig());
    expect(screen.getByRole("button", { name: "Purple" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sky" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Green" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Orange" })).toBeInTheDocument();
  });

  it("clicking Sky calls saveConfig exactly once with accent sky, editor and dailyNotes unchanged", async () => {
    const config = makeConfig();
    const { saveConfig } = renderSection(config);
    fireEvent.click(screen.getByRole("button", { name: "Sky" }));

    expect(saveConfig).toHaveBeenCalledTimes(1);
    const saved = saveConfig.mock.calls[0][0] as Config;
    expect(saved.accent).toBe("sky");
    expect(saved.editor).toEqual(config.editor);
    expect(saved.dailyNotes).toEqual(config.dailyNotes);
  });

  it("reverts --color-accent on document.documentElement and calls onSaveError on a rejected save", async () => {
    const config = makeConfig({ accent: "purple" });
    const saveConfig = vi.fn().mockResolvedValue({ error: { message: "offline" } });
    const { onSaveError } = renderSection(config, saveConfig);

    fireEvent.click(screen.getByRole("button", { name: "Sky" }));
    await waitFor(() => expect(onSaveError).toHaveBeenCalled());

    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#a78bfa");
    expect(onSaveError).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });

  it("exposes aria-pressed on the reading-font pills matching config.readingFont", () => {
    renderSection(makeConfig({ readingFont: "serif" }));
    expect(screen.getByRole("button", { name: "Sans" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Serif" })).toHaveAttribute("aria-pressed", "true");
  });

  it("never invokes the useAccent hook when the accent swatch is clicked, only its helper exports", () => {
    renderSection(makeConfig());
    fireEvent.click(screen.getByRole("button", { name: "Sky" }));

    expect(useAccent).not.toHaveBeenCalled();
    expect(applyAccent).toHaveBeenCalledWith("sky");
    expect(persistAccentBootstrap).toHaveBeenCalledWith("sky");
  });

  it("never invokes the useAccent hook when a reading-font pill is clicked, only its helper exports", () => {
    renderSection(makeConfig({ readingFont: "sans" }));
    fireEvent.click(screen.getByRole("button", { name: "Serif" }));

    expect(useAccent).not.toHaveBeenCalled();
    expect(applyReadingFont).toHaveBeenCalledWith("serif");
    expect(persistReadingFontBootstrap).toHaveBeenCalledWith("serif");
  });

  it("does not render the removed inline reading-font preview paragraph", () => {
    renderSection(makeConfig());
    expect(screen.queryByText(/quick brown fox/i)).toBeNull();
  });
});
