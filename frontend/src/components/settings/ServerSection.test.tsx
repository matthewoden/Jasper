import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../lib/useConfig";
import { ServerSection } from "./ServerSection";

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

function renderSection(
  config: Config,
  opts: { showBindBadge?: boolean; saveConfig?: ReturnType<typeof vi.fn> } = {},
) {
  const saveConfig = opts.saveConfig ?? vi.fn().mockResolvedValue({});
  const onSaveError = vi.fn();
  render(
    <ServerSection
      config={config}
      saveConfig={saveConfig}
      onSaveError={onSaveError}
      showBindBadge={opts.showBindBadge ?? false}
    />,
  );
  return { saveConfig, onSaveError };
}

describe("ServerSection", () => {
  it("renders the bind input with the config value and commits on Enter", () => {
    const config = makeConfig({ server: { port: 6683, dataDir: "/vault", bind: "127.0.0.1" } });
    const { saveConfig } = renderSection(config);
    const input = screen.getByLabelText("Bind address");
    expect(input).toHaveValue("127.0.0.1");

    fireEvent.change(input, { target: { value: "0.0.0.0" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(saveConfig).toHaveBeenCalledTimes(1);
    const saved = saveConfig.mock.calls[0][0] as Config;
    expect(saved.server?.bind).toBe("0.0.0.0");
  });

  it("renders the restart badge only when showBindBadge is true", () => {
    const config = makeConfig();
    const { rerender } = render(
      <ServerSection
        config={config}
        saveConfig={vi.fn().mockResolvedValue({})}
        onSaveError={vi.fn()}
        showBindBadge={false}
      />,
    );
    expect(screen.queryByLabelText("Requires reload to apply")).toBeNull();

    rerender(
      <ServerSection
        config={config}
        saveConfig={vi.fn().mockResolvedValue({})}
        onSaveError={vi.fn()}
        showBindBadge={true}
      />,
    );
    expect(screen.getByLabelText("Requires reload to apply")).toBeInTheDocument();
  });

  it("shows the beyond-loopback alert only for a non-loopback persisted bind value", () => {
    for (const bind of ["127.0.0.1", "localhost", "::1"]) {
      const { unmount } = render(
        <ServerSection
          config={makeConfig({ server: { port: 6683, dataDir: "/vault", bind } })}
          saveConfig={vi.fn().mockResolvedValue({})}
          onSaveError={vi.fn()}
          showBindBadge={false}
        />,
      );
      expect(screen.queryByRole("alert")).toBeNull();
      unmount();
    }

    render(
      <ServerSection
        config={makeConfig({ server: { port: 6683, dataDir: "/vault", bind: "0.0.0.0" } })}
        saveConfig={vi.fn().mockResolvedValue({})}
        onSaveError={vi.fn()}
        showBindBadge={false}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Jasper is exposed on all network interfaces. Only enable LAN access on trusted networks.",
    );
  });

  it("does not show the alert for an uncommitted 0.0.0.0 typed into the input", () => {
    const config = makeConfig({ server: { port: 6683, dataDir: "/vault", bind: "127.0.0.1" } });
    renderSection(config);
    const input = screen.getByLabelText("Bind address");

    fireEvent.change(input, { target: { value: "0.0.0.0" } });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders no control matching MCP port, audit, or grant", () => {
    renderSection(makeConfig());
    expect(screen.queryByLabelText(/mcp|audit|grant/i)).toBeNull();
    expect(screen.queryByText(/mcp|audit|grant/i)).toBeNull();
  });
});
