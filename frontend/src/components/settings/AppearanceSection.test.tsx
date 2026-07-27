import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, ConfigPatch } from "../../lib/useConfig";

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

  it("names the accent swatch group, matching the sibling Reading font row (32-REVIEW WR-03)", () => {
    renderSection(makeConfig());
    const group = screen.getByRole("group", { name: "Accent color" });
    expect(group).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Purple" })).toBeInTheDocument();
  });

  it("clicking Sky calls saveConfig exactly once with a bare { accent } partial", async () => {
    const config = makeConfig();
    const { saveConfig } = renderSection(config);
    fireEvent.click(screen.getByRole("button", { name: "Sky" }));

    // Awaited, not asserted synchronously: the save resolves asynchronously
    // and an unawaited resolution leaks a state update into the next test.
    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1));
    const saved = saveConfig.mock.calls[0][0] as ConfigPatch;
    expect(saved.accent).toBe("sky");
    expect(Object.keys(saved)).toEqual(["accent"]);
    expect(saved.editor).toBeUndefined();
    expect(saved.dailyNotes).toBeUndefined();
  });

  it("clicking the already-selected accent swatch calls saveConfig zero times and does not touch localStorage's bootstrap key", () => {
    const { saveConfig } = renderSection(makeConfig({ accent: "purple" }));
    fireEvent.click(screen.getByRole("button", { name: "Purple" }));

    expect(saveConfig).toHaveBeenCalledTimes(0);
    expect(persistAccentBootstrap).not.toHaveBeenCalled();
  });

  it("clicking the already-active reading-font pill calls saveConfig zero times", () => {
    const { saveConfig } = renderSection(makeConfig({ readingFont: "sans" }));
    fireEvent.click(screen.getByRole("button", { name: "Sans" }));

    expect(saveConfig).toHaveBeenCalledTimes(0);
    expect(persistReadingFontBootstrap).not.toHaveBeenCalled();
  });

  it("tabbing through the font-size and line-height number inputs without changing any value issues zero saveConfig calls (WR-06)", () => {
    const { saveConfig } = renderSection(makeConfig());
    const fontSizeInput = screen.getByRole("spinbutton", { name: "Font size" });
    const lineHeightInput = screen.getByRole("spinbutton", { name: "Line height" });

    fireEvent.focus(fontSizeInput);
    fireEvent.blur(fontSizeInput);
    fireEvent.focus(lineHeightInput);
    fireEvent.blur(lineHeightInput);

    expect(saveConfig).toHaveBeenCalledTimes(0);
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
    expect(screen.queryByText("Applies to note content only")).toBeNull();
  });

  it("renders all four Appearance row captions", () => {
    renderSection(makeConfig());
    expect(screen.getByText("Used for links, tags, highlights and selection")).toBeInTheDocument();
    expect(screen.getByText("Typeface for note body text")).toBeInTheDocument();
    expect(screen.getByText("Body text size in the editor · 8–32px")).toBeInTheDocument();
    expect(
      screen.getByText("Vertical rhythm of paragraphs and lists · 1.0–3.0"),
    ).toBeInTheDocument();
  });

  it("points both halves of each slider pair at the caption carrying the validator bounds (32-REVIEW WR-02)", () => {
    renderSection(makeConfig());

    for (const [name, caption] of [
      ["Font size", "Body text size in the editor · 8–32px"],
      ["Line height", "Vertical rhythm of paragraphs and lists · 1.0–3.0"],
    ] as const) {
      for (const role of ["slider", "spinbutton"] as const) {
        const control = screen.getByRole(role, { name });
        const descId = control.getAttribute("aria-describedby");
        expect(descId).toBeTruthy();
        expect(document.getElementById(descId!)).toHaveTextContent(caption);
      }
    }
  });

  it("drag events on the font-size slider update --editor-font-size without calling saveConfig", () => {
    const config = makeConfig();
    const { saveConfig } = renderSection(config);
    const slider = screen.getByRole("slider", { name: "Font size" });

    fireEvent.change(slider, { target: { value: "16" } });
    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("16px");
    fireEvent.change(slider, { target: { value: "18" } });
    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("18px");
    fireEvent.change(slider, { target: { value: "20" } });
    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("20px");

    expect(saveConfig).toHaveBeenCalledTimes(0);
  });

  it("releasing the font-size slider calls saveConfig exactly once with a bare { editor: { fontSize } } partial", async () => {
    const config = makeConfig();
    const { saveConfig } = renderSection(config);
    const slider = screen.getByRole("slider", { name: "Font size" });

    fireEvent.change(slider, { target: { value: "20" } });
    fireEvent.pointerUp(slider);

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1));
    const saved = saveConfig.mock.calls[0][0] as ConfigPatch;
    expect(Object.keys(saved)).toEqual(["editor"]);
    expect(Object.keys(saved.editor!)).toEqual(["fontSize"]);
    expect(saved.editor?.fontSize).toBe(20);
    expect(saved.editor?.autosaveMs).toBeUndefined();
  });

  it("drag events on the line-height slider update --editor-line-height without calling saveConfig, release commits once with a bare { editor: { lineHeight } } partial", async () => {
    const config = makeConfig();
    const { saveConfig } = renderSection(config);
    const slider = screen.getByRole("slider", { name: "Line height" });

    fireEvent.change(slider, { target: { value: "1.5" } });
    expect(document.documentElement.style.getPropertyValue("--editor-line-height")).toBe("1.5");
    expect(saveConfig).toHaveBeenCalledTimes(0);

    fireEvent.pointerUp(slider);
    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1));
    const saved = saveConfig.mock.calls[0][0] as ConfigPatch;
    expect(Object.keys(saved)).toEqual(["editor"]);
    expect(Object.keys(saved.editor!)).toEqual(["lineHeight"]);
    expect(saved.editor?.lineHeight).toBe(1.5);
  });

  it("TypePreviewPanel reflects the live just-committed font size before the persisted config catches up", async () => {
    const config = makeConfig({ editor: { ...makeConfig().editor, fontSize: 15 } });
    let resolveSave: (v: { error?: undefined }) => void = () => {};
    const saveConfig = vi.fn(
      () => new Promise<{ error?: undefined }>((resolve) => { resolveSave = resolve; }),
    );
    renderSection(config, saveConfig);

    const slider = screen.getByRole("slider", { name: "Font size" });
    fireEvent.change(slider, { target: { value: "22" } });
    fireEvent.pointerUp(slider);

    const preview = screen.getByText(/Type styling applies instantly/);
    expect(preview).toHaveStyle({ fontSize: "22px" });

    // Settle the deferred save inside this test's act scope rather than
    // letting its .then land during the next test.
    resolveSave({});
    await waitFor(() => expect(preview).toHaveStyle({ fontSize: "22px" }));
  });

  it("reverts both the live preview value and --editor-font-size on a rejected font-size save", async () => {
    const config = makeConfig({ editor: { ...makeConfig().editor, fontSize: 15 } });
    const saveConfig = vi.fn().mockResolvedValue({ error: { message: "offline" } });
    const { onSaveError } = renderSection(config, saveConfig);

    const slider = screen.getByRole("slider", { name: "Font size" });
    fireEvent.change(slider, { target: { value: "22" } });
    fireEvent.pointerUp(slider);

    await waitFor(() => expect(onSaveError).toHaveBeenCalled());

    const preview = screen.getByText(/Type styling applies instantly/);
    expect(preview).toHaveStyle({ fontSize: "15px" });
    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("15px");
  });

  it("renders exactly one TypePreviewPanel", () => {
    renderSection(makeConfig());
    expect(screen.getAllByText(/Type styling applies instantly/)).toHaveLength(1);
  });
});
