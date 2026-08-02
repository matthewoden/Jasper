/**
 * Tests for the Reset-and-Rebuild confirmation dialog.
 *
 * Covers the locked copy and interaction contract.
 * Radix AlertDialog manages focus trap + ESC + outside-click; we assert
 * that our wiring of `onOpenChange` / `onConfirm` is correct, not that
 * Radix internally implements the focus trap (that's Radix's test suite).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ResetAndRebuildDialog } from "./ResetAndRebuildDialog";

describe("<ResetAndRebuildDialog />", () => {
  it("RD1: does not render dialog content when open=false", () => {
    render(
      <ResetAndRebuildDialog
        open={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText("Reset the database?")).toBeNull();
  });

  it("RD2: renders the locked title + body + actions when open=true", () => {
    render(
      <ResetAndRebuildDialog
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Reset the database?")).toBeInTheDocument();
    expect(
      screen.getByText(
        /This drops the SQLite index and rebuilds it by reading every note file from disk\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/files are not touched/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Keep current schema" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reset and rebuild" }),
    ).toBeInTheDocument();
  });

  it("RD3: clicking 'Reset and rebuild' fires onConfirm", () => {
    const onConfirm = vi.fn();
    render(
      <ResetAndRebuildDialog
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reset and rebuild" }),
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("RD4: clicking 'Keep current schema' fires onOpenChange(false)", () => {
    const onOpenChange = vi.fn();
    render(
      <ResetAndRebuildDialog
        open={true}
        onOpenChange={onOpenChange}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Keep current schema" }),
    );
    expect(onOpenChange).toHaveBeenCalled();
    const calls = onOpenChange.mock.calls;
    const hasFalse = calls.some(([arg]) => arg === false);
    expect(hasFalse).toBe(true);
  });

  it("RD5: ESC key fires onOpenChange(false)", () => {
    const onOpenChange = vi.fn();
    render(
      <ResetAndRebuildDialog
        open={true}
        onOpenChange={onOpenChange}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByRole("alertdialog"), {
      key: "Escape",
      code: "Escape",
    });
    const hasFalse = onOpenChange.mock.calls.some(([arg]) => arg === false);
    expect(hasFalse).toBe(true);
  });

  it("RD6: confirm button uses semibold weight (locked styling)", () => {
    render(
      <ResetAndRebuildDialog
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const confirmBtn = screen.getByRole("button", {
      name: "Reset and rebuild",
    });
    expect(confirmBtn.style.fontWeight).toBe("600");
  });
});
