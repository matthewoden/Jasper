/**
 * TreeErrorState tests — UI-SPEC §Surface 1 §Error state.
 *
 * Locked copy:
 *   Headline: "Couldn't load the tree." (text-destructive)
 *   Action:   "Try again" (28px tall, 1px border-border)
 *
 * Container has role="alert" so screen readers announce the failure.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TreeErrorState } from "./TreeErrorState";

describe("<TreeErrorState />", () => {
  it("TestErrorState_RendersHeadline", () => {
    render(<TreeErrorState onRetry={() => {}} />);
    expect(screen.getByText("Couldn't load the tree.")).toBeInTheDocument();
  });

  it("TestErrorState_RetryButton_OnClick", () => {
    const onRetry = vi.fn();
    render(<TreeErrorState onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("TestErrorState_HasRoleAlert", () => {
    render(<TreeErrorState onRetry={() => {}} />);
    // Container is the role="alert" element so screen readers announce.
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("Try again button is 28px tall with 1px border-border per UI-SPEC", () => {
    render(<TreeErrorState onRetry={() => {}} />);
    const btn = screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement;
    expect(btn.style.height).toBe("28px");
    expect(btn.style.border).toContain("1px");
    // border style references --color-border via inline style; assert the var name appears.
    expect(btn.style.border).toContain("--color-border");
  });
});
