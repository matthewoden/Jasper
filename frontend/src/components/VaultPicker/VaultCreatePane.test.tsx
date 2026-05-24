/**
 * VaultCreatePane tests — Plan 08-17c Task 2.
 *
 * Tests 4-section structure, 08-16 N8/N3 copy verbatim, and submit behavior.
 */
import { describe, it, expect, vi } from "vitest";
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

import { VaultCreatePane } from "./VaultCreatePane";
import { vaultApi } from "../../lib/vaultApi";
import { TIER_1_LABEL, TIER_2_LABEL, DAILY_TEMPLATE_REQUIRED_LABEL, DAILY_TEMPLATE_HELP } from "./vaultCopy";

describe("<VaultCreatePane />", () => {
  it("renders all 4 sections (path, theme, MCP, daily-note)", () => {
    render(<VaultCreatePane onCreated={vi.fn()} />);
    // Section 1: path
    expect(screen.getByTestId("vault-create-path-input")).toBeInTheDocument();
    // Section 2: theme (dark/light radio)
    expect(screen.getByRole("radio", { name: /dark/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /light/i })).toBeInTheDocument();
    // Section 3: MCP
    expect(screen.getByRole("checkbox", { name: /enable mcp/i })).toBeInTheDocument();
    // Section 4: daily note template
    expect(screen.getByRole("textbox", { name: /daily note template/i })).toBeInTheDocument();
  });

  it(`renders Tier-1 copy: "${TIER_1_LABEL}"`, () => {
    render(<VaultCreatePane onCreated={vi.fn()} />);
    // Enable MCP to show the grants section
    fireEvent.click(screen.getByRole("checkbox", { name: /enable mcp/i }));
    expect(screen.getByText(TIER_1_LABEL)).toBeInTheDocument();
  });

  it(`renders Tier-2 copy: "${TIER_2_LABEL}"`, () => {
    render(<VaultCreatePane onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /enable mcp/i }));
    expect(screen.getByText(TIER_2_LABEL)).toBeInTheDocument();
  });

  it(`renders REQUIRED eyebrow: "${DAILY_TEMPLATE_REQUIRED_LABEL}"`, () => {
    render(<VaultCreatePane onCreated={vi.fn()} />);
    expect(screen.getByText(DAILY_TEMPLATE_REQUIRED_LABEL)).toBeInTheDocument();
  });

  it(`renders {{date}} help text`, () => {
    render(<VaultCreatePane onCreated={vi.fn()} />);
    expect(screen.getByText(new RegExp(DAILY_TEMPLATE_HELP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
  });

  it("submit is disabled when path is empty", () => {
    render(<VaultCreatePane onCreated={vi.fn()} />);
    expect(screen.getByRole("button", { name: /create vault/i })).toBeDisabled();
  });

  it("calls vaultApi.create with assembled payload on submit", async () => {
    // Mock reload
    Object.defineProperty(window, "location", {
      value: { reload: vi.fn() },
      writable: true,
    });
    const onCreated = vi.fn();
    render(<VaultCreatePane onCreated={onCreated} />);
    const input = screen.getByTestId("vault-create-path-input");
    fireEvent.change(input, { target: { value: "/Users/me/vault" } });
    fireEvent.click(screen.getByRole("button", { name: /create vault/i }));
    await waitFor(() => {
      expect(vaultApi.create).toHaveBeenCalled();
    });
    const callArg = vi.mocked(vaultApi.create).mock.calls[0][0];
    expect(callArg.path).toBe("/Users/me/vault");
    expect(callArg.theme).toBe("dark"); // Default dark per D-06
  });
});
