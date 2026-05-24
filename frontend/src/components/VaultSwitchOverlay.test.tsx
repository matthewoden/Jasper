/**
 * VaultSwitchOverlay tests — Plan 08-17d Task 3.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VaultSwitchOverlay } from "./VaultSwitchOverlay";

describe("<VaultSwitchOverlay />", () => {
  it("renders the target vault name in the switching message", () => {
    render(<VaultSwitchOverlay targetName="Work Notes" />);
    expect(screen.getByText(/Switching to Work Notes/i)).toBeInTheDocument();
  });

  it("has role=dialog and aria-modal=true", () => {
    render(<VaultSwitchOverlay targetName="Work Notes" />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("has aria-label indicating the switch is in progress", () => {
    render(<VaultSwitchOverlay targetName="Work Notes" />);
    expect(screen.getByLabelText(/switching vault/i)).toBeInTheDocument();
  });

  it("renders different targetName values correctly", () => {
    const { rerender } = render(<VaultSwitchOverlay targetName="Vault A" />);
    expect(screen.getByText(/Switching to Vault A/i)).toBeInTheDocument();
    rerender(<VaultSwitchOverlay targetName="My Notes" />);
    expect(screen.getByText(/Switching to My Notes/i)).toBeInTheDocument();
  });
});
