/**
 * VaultCreatePane tests — Plan 08-17c Task 2 + UAT-2 #1d rework.
 *
 * New surface (post-UAT-2 #1d):
 *   - 3 sections (vault path / theme / daily template) — MCP grants moved
 *     out of vault creation per "a new vault is always empty."
 *   - Daily template pre-filled with `# {{date}}\n\n` (sensible default).
 *   - Theme picker live-applies to <html data-theme> on radio change.
 *   - Submit button is the primary action and stays disabled until path
 *     validates.
 *   - Submit always posts mcp_enabled: false (MCP enabled post-vault).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../../lib/vaultApi", () => ({
  vaultApi: {
    create: vi.fn().mockResolvedValue({
      path: "/vault",
      display_name: "vault",
      last_opened_at: "2026-05-24T00:00:00Z",
      created_at: "2026-05-24T00:00:00Z",
      missing: false,
    }),
  },
  validateVaultPath: vi.fn((path: string) => {
    if (!path) return { ok: false, code: "empty", message: "Path is required." };
    if (!path.startsWith("/"))
      return { ok: false, code: "not-abs", message: "Path must be absolute (starts with /)." };
    return { ok: true };
  }),
}));

const applyThemeMock = vi.fn();
vi.mock("../../lib/useTheme", () => ({
  applyTheme: (t: "dark" | "light") => applyThemeMock(t),
}));

import { VaultCreatePane } from "./VaultCreatePane";
import { vaultApi } from "../../lib/vaultApi";

describe("<VaultCreatePane />", () => {
  beforeEach(() => {
    applyThemeMock.mockClear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("renders 3 sections (path, theme, daily-note) — no MCP grants", () => {
    render(<VaultCreatePane onCreated={vi.fn()} />);
    expect(screen.getByTestId("vault-create-path-input")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /dark/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /light/i })).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: /daily note template/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /enable mcp/i })).toBeNull();
  });

  it("pre-fills daily template with the backend default `# {{date}}\\n\\n`", () => {
    render(<VaultCreatePane onCreated={vi.fn()} />);
    const ta = screen.getByRole("textbox", {
      name: /daily note template/i,
    }) as HTMLTextAreaElement;
    expect(ta.value).toBe("# {{date}}\n\n");
  });

  it("submit is disabled when path is empty", () => {
    render(<VaultCreatePane onCreated={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /create vault/i }),
    ).toBeDisabled();
  });

  it("submit enables once path validates", () => {
    render(<VaultCreatePane onCreated={vi.fn()} />);
    fireEvent.change(screen.getByTestId("vault-create-path-input"), {
      target: { value: "/Users/me/vault" },
    });
    expect(
      screen.getByRole("button", { name: /create vault/i }),
    ).not.toBeDisabled();
  });

  it("theme radio applies live to <html data-theme> on change", () => {
    render(<VaultCreatePane onCreated={vi.fn()} />);
    expect(applyThemeMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: /light/i }));
    expect(applyThemeMock).toHaveBeenLastCalledWith("light");
    fireEvent.click(screen.getByRole("radio", { name: /dark/i }));
    expect(applyThemeMock).toHaveBeenLastCalledWith("dark");
  });

  it("calls vaultApi.create with assembled payload (mcp_enabled always false)", async () => {
    Object.defineProperty(window, "location", {
      value: { reload: vi.fn() },
      writable: true,
    });
    const onCreated = vi.fn();
    render(<VaultCreatePane onCreated={onCreated} />);
    fireEvent.change(screen.getByTestId("vault-create-path-input"), {
      target: { value: "/Users/me/vault" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create vault/i }));
    await waitFor(() => {
      expect(vaultApi.create).toHaveBeenCalled();
    });
    const callArg = vi.mocked(vaultApi.create).mock.calls[0][0];
    expect(callArg.path).toBe("/Users/me/vault");
    expect(callArg.theme).toBe("dark");
    expect(callArg.mcp_enabled).toBe(false);
    expect(callArg.daily_template).toBe("# {{date}}\n\n");
  });
});
