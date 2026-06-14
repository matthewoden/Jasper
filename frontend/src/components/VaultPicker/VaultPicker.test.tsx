/** VaultPicker tests — modal shell with three tabs (Recent / Open existing / Create new). */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";


vi.mock("../../lib/useVaultPicker", () => ({
  useVaultPicker: vi.fn(() => ({
    isOpen: true,
    open: vi.fn(),
    close: vi.fn(),
    current: null,
    recents: [],
    banner: "",
    isLoading: false,
    refresh: vi.fn(),
  })),
}));


vi.mock("../../lib/vaultApi", () => ({
  vaultApi: {
    getCurrent: vi.fn().mockResolvedValue(null),
    getRecent: vi.fn().mockResolvedValue({ vaults: [], banner: "" }),
    open: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
    forget: vi.fn().mockResolvedValue(undefined),
  },
  validateVaultPath: vi.fn().mockReturnValue({ ok: true }),
}));

import { VaultPicker } from "./VaultPicker";
import { useVaultPicker } from "../../lib/useVaultPicker";

describe("<VaultPicker />", () => {
  it("renders the dialog with the correct aria-label", () => {
    render(<VaultPicker mode="boot" />);
    expect(screen.getByRole("dialog", { name: /vault/i })).toBeInTheDocument();
  });

  it("renders banner when banner is non-empty", () => {
    vi.mocked(useVaultPicker).mockReturnValue({
      isOpen: true,
      open: vi.fn(),
      close: vi.fn(),
      current: null,
      recents: [],
      banner: "Previous vault missing",
      isLoading: false,
      refresh: vi.fn(),
    });
    render(<VaultPicker mode="boot" />);
    expect(screen.getByText("Previous vault missing")).toBeInTheDocument();
  });

  it("defaults to 'create' tab when recents is empty", () => {
    vi.mocked(useVaultPicker).mockReturnValue({
      isOpen: true,
      open: vi.fn(),
      close: vi.fn(),
      current: null,
      recents: [],
      banner: "",
      isLoading: false,
      refresh: vi.fn(),
    });
    render(<VaultPicker mode="boot" />);
    const createTab = screen.getByRole("tab", { name: /create new/i });
    expect(createTab).toHaveAttribute("aria-selected", "true");
  });

  it("defaults to 'recent' tab when recents is non-empty", () => {
    vi.mocked(useVaultPicker).mockReturnValue({
      isOpen: true,
      open: vi.fn(),
      close: vi.fn(),
      current: null,
      recents: [
        {
          path: "/vault1",
          display_name: "Vault 1",
          last_opened_at: "2026-05-24T00:00:00Z",
          created_at: "2026-05-24T00:00:00Z",
          missing: false,
        },
      ],
      banner: "",
      isLoading: false,
      refresh: vi.fn(),
    });
    render(<VaultPicker mode="boot" />);
    const recentTab = screen.getByRole("tab", { name: /recent/i });
    expect(recentTab).toHaveAttribute("aria-selected", "true");
  });

  it("clicking 'Open existing…' tab shows the open pane", () => {
    vi.mocked(useVaultPicker).mockReturnValue({
      isOpen: true,
      open: vi.fn(),
      close: vi.fn(),
      current: null,
      recents: [],
      banner: "",
      isLoading: false,
      refresh: vi.fn(),
    });
    render(<VaultPicker mode="boot" />);
    fireEvent.click(screen.getByRole("tab", { name: /open existing/i }));
    expect(screen.getByTestId("vault-open-input")).toBeInTheDocument();
  });
});
