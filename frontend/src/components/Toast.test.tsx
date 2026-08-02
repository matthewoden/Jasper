/**
 * The error-variant border check is a sentinel for the "destructive surface for
 * non-warning toasts" rule, not a styling snapshot.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ToastProvider } from "./Toast";
import { useToast, type ToastOptions } from "./toast.utils";

function Trigger({ opts, label }: { opts: ToastOptions; label: string }) {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast(opts)}>
      {label}
    </button>
  );
}

describe("<ToastProvider /> + useToast", () => {
  it("T1: useToast throws when used outside ToastProvider", () => {
    function Bad() {
      useToast();
      return null;
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Bad />)).toThrow(
      /useToast must be used inside <ToastProvider>/,
    );
    spy.mockRestore();
  });

  it("T2: calling toast() renders the title text", () => {
    render(
      <ToastProvider>
        <Trigger
          opts={{ title: "Saved successfully" }}
          label="Fire toast"
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("Fire toast"));
    expect(screen.getByText("Saved successfully")).toBeInTheDocument();
  });

  it("T3: clicking the close button dismisses the toast", () => {
    render(
      <ToastProvider>
        <Trigger
          opts={{ title: "Sticky toast" }}
          label="Fire"
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("Fire"));
    expect(screen.getByText("Sticky toast")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Dismiss notification"));
    expect(screen.queryByText("Sticky toast")).toBeNull();
  });

  it("T4: description is rendered when provided", () => {
    render(
      <ToastProvider>
        <Trigger
          opts={{
            title: "That name already exists.",
            description:
              "`Notes/foo.md` matches an existing note when names are compared case-insensitively. Try a different name.",
          }}
          label="Fire"
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("Fire"));
    expect(
      screen.getByText("That name already exists."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/matches an existing note/),
    ).toBeInTheDocument();
  });

  it("T5: multiple toasts render concurrently in the viewport", () => {
    render(
      <ToastProvider>
        <Trigger opts={{ title: "First" }} label="A" />
        <Trigger opts={{ title: "Second" }} label="B" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("A"));
    fireEvent.click(screen.getByText("B"));
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("T6: aria-label on close is the locked 'Dismiss notification' string", () => {
    render(
      <ToastProvider>
        <Trigger opts={{ title: "X" }} label="A" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("A"));
    expect(screen.getByLabelText("Dismiss notification")).toBeInTheDocument();
  });
});
