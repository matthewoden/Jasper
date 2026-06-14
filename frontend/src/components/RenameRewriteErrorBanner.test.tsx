/** RenameRewriteErrorBanner tests — EB1..EB5. */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RenameRewriteErrorBanner } from "./RenameRewriteErrorBanner";


describe("EB1: hidden when state is null", () => {
  it("renders nothing when state is null", () => {
    const { container } = render(
      <RenameRewriteErrorBanner state={null} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});


describe("EB2: kind='rename' shows Rename failed title and body", () => {
  it("renders title 'Rename failed' and body with missedCount", () => {
    render(
      <RenameRewriteErrorBanner
        state={{ kind: "rename", missedCount: 3 }}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("Rename failed")).toBeInTheDocument();
    expect(
      screen.getByText(/3 references could not be updated/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/the rename has been rolled back/i)).toBeInTheDocument();
  });

  it("shows 'Some' when missedCount is absent", () => {
    render(
      <RenameRewriteErrorBanner
        state={{ kind: "rename" }}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/some references could not be updated/i)).toBeInTheDocument();
  });

  it("renders Dismiss button", () => {
    render(
      <RenameRewriteErrorBanner
        state={{ kind: "rename" }}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /dismiss error/i })).toBeInTheDocument();
  });
});


describe("EB3: kind='tag-rewrite' shows Tag rewrite failed title with tag interpolation", () => {
  it("renders title 'Tag rewrite failed' and body with targetName", () => {
    render(
      <RenameRewriteErrorBanner
        state={{ kind: "tag-rewrite", targetName: "project/jasper" }}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("Tag rewrite failed")).toBeInTheDocument();
    expect(
      screen.getByText(/"project\/jasper" could not be updated across all notes/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/the change has been rolled back/i),
    ).toBeInTheDocument();
  });
});


describe("EB4: clicking Dismiss calls onDismiss", () => {
  it("calls onDismiss when the X button is clicked", () => {
    const onDismiss = vi.fn();
    render(
      <RenameRewriteErrorBanner
        state={{ kind: "rename", missedCount: 1 }}
        onDismiss={onDismiss}
      />,
    );
    const dismissBtn = screen.getByRole("button", { name: /dismiss error/i });
    fireEvent.click(dismissBtn);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});


describe("EB5: role='alert' for screen reader announcement", () => {
  it("has role='alert' when showing an error", () => {
    render(
      <RenameRewriteErrorBanner
        state={{ kind: "rename" }}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
