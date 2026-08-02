/**
 * Purely presentational — the parent owns the phase enum, so these tests pass
 * `phase` directly as a prop rather than driving a state machine.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReindexProgress } from "./ReindexProgress";

afterEach(() => {
  vi.useRealTimers();
});

describe("<ReindexProgress />", () => {
  it("RP1: renders nothing when phase=idle", () => {
    render(<ReindexProgress phase="idle" />);
    expect(screen.queryByText(/Rebuilding/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("RP2: shows the locked running copy and an indeterminate bar", () => {
    render(<ReindexProgress phase="running" />);
    expect(screen.getByText("Rebuilding the index…")).toBeInTheDocument();
    expect(
      screen.getByText("This usually takes a few seconds."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("in progress")).toBeInTheDocument();
  });

  it("RP3: shows the same headline for phase=starting", () => {
    render(<ReindexProgress phase="starting" />);
    expect(screen.getByText("Rebuilding the index…")).toBeInTheDocument();
  });

  it("RP4: phase=completing flashes 'Index rebuilt.' then fires onClose after the transient", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<ReindexProgress phase="completing" onClose={onClose} />);
    expect(screen.getByText("Index rebuilt.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("RP5: phase=error shows headline + body + retry + close; both buttons fire their callbacks", () => {
    const onRetry = vi.fn();
    const onClose = vi.fn();
    render(
      <ReindexProgress
        phase="error"
        errorMessage="db is busy"
        onRetry={onRetry}
        onClose={onClose}
      />,
    );

    expect(
      screen.getByText(/Couldn.t rebuild the index/),
    ).toBeInTheDocument();
    expect(screen.getByText("db is busy")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("RP6: error fallback message when errorMessage is undefined", () => {
    render(<ReindexProgress phase="error" onClose={vi.fn()} />);
    expect(
      screen.getByText("Try again or check the logs."),
    ).toBeInTheDocument();
  });

  it("RP7: error phase without onRetry omits the Try again button", () => {
    render(<ReindexProgress phase="error" onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("RP8: completing→idle transition (parent unmount) does not call onClose twice", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { rerender } = render(
      <ReindexProgress phase="completing" onClose={onClose} />,
    );
    rerender(<ReindexProgress phase="idle" onClose={onClose} />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
