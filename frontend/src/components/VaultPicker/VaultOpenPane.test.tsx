/** VaultOpenPane tests — path input validation, submit button state, onOpened callback. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../../lib/vaultApi", () => ({
  vaultApi: {
    open: vi.fn().mockResolvedValue({}),
  },
  validateVaultPath: vi.fn((path: string) => {
    if (!path) return { ok: false, code: "empty", message: "Path is required." };
    if (path.includes("🦊"))
      return {
        ok: false,
        code: "non-ascii",
        message: "Path must be ASCII for cross-platform safety. Rename the folder or pick a different one.",
      };
    if (!path.startsWith("/"))
      return { ok: false, code: "not-abs", message: "Path must be absolute (starts with /)." };
    return { ok: true };
  }),
}));

import { VaultOpenPane } from "./VaultOpenPane";
import { vaultApi } from "../../lib/vaultApi";

describe("<VaultOpenPane />", () => {
  it("submit button disabled when path is empty", () => {
    render(<VaultOpenPane onOpened={vi.fn()} />);
    expect(screen.getByTestId("vault-open-submit")).toBeDisabled();
  });

  it("shows validation error for non-ASCII path", () => {
    render(<VaultOpenPane onOpened={vi.fn()} />);
    const input = screen.getByTestId("vault-open-input");
    fireEvent.change(input, { target: { value: "/path/with-emoji-🦊" } });
    expect(screen.getByText(/ASCII/i)).toBeInTheDocument();
    expect(screen.getByTestId("vault-open-submit")).toBeDisabled();
  });

  it("submit enabled and calls onOpened when path valid", async () => {
    const onOpened = vi.fn();
    render(<VaultOpenPane onOpened={onOpened} />);
    const input = screen.getByTestId("vault-open-input");
    fireEvent.change(input, { target: { value: "/Users/me/vault" } });
    expect(screen.getByTestId("vault-open-submit")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("vault-open-submit"));
    await waitFor(() => {
      expect(vaultApi.open).toHaveBeenCalledWith("/Users/me/vault");
      expect(onOpened).toHaveBeenCalled();
    });
  });

  it("pre-fills initialPath when provided", () => {
    render(<VaultOpenPane initialPath="/Users/me/vault" onOpened={vi.fn()} />);
    const input = screen.getByTestId("vault-open-input") as HTMLInputElement;
    expect(input.value).toBe("/Users/me/vault");
  });
});
