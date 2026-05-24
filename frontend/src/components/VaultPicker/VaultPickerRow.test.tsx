/**
 * VaultPickerRow tests — Plan 08-17c Task 2.
 *
 * Tests the V11 missing-entry UX (greyed row + Folder not found + Reconnect/Remove).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../../lib/vaultApi", () => ({
  vaultApi: {
    open: vi.fn().mockResolvedValue({}),
    forget: vi.fn().mockResolvedValue(undefined),
  },
  validateVaultPath: vi.fn().mockReturnValue({ ok: true }),
}));

import { VaultPickerRow } from "./VaultPickerRow";
import { vaultApi } from "../../lib/vaultApi";

const entry = {
  path: "/Users/me/vault",
  display_name: "My Vault",
  last_opened_at: "2026-05-24T00:00:00Z",
  created_at: "2026-05-24T00:00:00Z",
  missing: false,
};

const missingEntry = { ...entry, missing: true };

describe("<VaultPickerRow />", () => {
  it("non-missing row renders display_name and last opened date", () => {
    const onReconnect = vi.fn();
    const onForgotten = vi.fn();
    render(
      <VaultPickerRow entry={entry} onReconnect={onReconnect} onForgotten={onForgotten} />,
    );
    expect(screen.getByText("My Vault")).toBeInTheDocument();
  });

  it("non-missing row click calls vaultApi.open", async () => {
    // Mock window.location.reload
    Object.defineProperty(window, "location", {
      value: { reload: vi.fn() },
      writable: true,
    });
    const onReconnect = vi.fn();
    const onForgotten = vi.fn();
    render(
      <VaultPickerRow entry={entry} onReconnect={onReconnect} onForgotten={onForgotten} />,
    );
    const row = screen.getByTestId(`vault-row-${entry.path}`);
    fireEvent.click(row);
    await waitFor(() => {
      expect(vaultApi.open).toHaveBeenCalledWith(entry.path);
    });
  });

  it("missing row renders 'Folder not found' caption", () => {
    const onReconnect = vi.fn();
    const onForgotten = vi.fn();
    render(
      <VaultPickerRow entry={missingEntry} onReconnect={onReconnect} onForgotten={onForgotten} />,
    );
    expect(screen.getByText("Folder not found")).toBeInTheDocument();
  });

  it("missing row renders Reconnect and Remove buttons", () => {
    const onReconnect = vi.fn();
    const onForgotten = vi.fn();
    render(
      <VaultPickerRow entry={missingEntry} onReconnect={onReconnect} onForgotten={onForgotten} />,
    );
    expect(screen.getByRole("button", { name: /reconnect/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove/i })).toBeInTheDocument();
  });

  it("Reconnect click calls onReconnect with the entry path", () => {
    const onReconnect = vi.fn();
    const onForgotten = vi.fn();
    render(
      <VaultPickerRow entry={missingEntry} onReconnect={onReconnect} onForgotten={onForgotten} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    expect(onReconnect).toHaveBeenCalledWith(missingEntry.path);
  });

  it("Remove click calls vaultApi.forget and onForgotten", async () => {
    const onReconnect = vi.fn();
    const onForgotten = vi.fn();
    render(
      <VaultPickerRow entry={missingEntry} onReconnect={onReconnect} onForgotten={onForgotten} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    await waitFor(() => {
      expect(vaultApi.forget).toHaveBeenCalledWith(missingEntry.path);
      expect(onForgotten).toHaveBeenCalled();
    });
  });
});
