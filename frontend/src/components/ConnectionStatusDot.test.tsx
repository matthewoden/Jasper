import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { TooltipProvider } from "./Tooltip";

vi.mock("../lib/useTreeStore", () => ({
  useTreeStore: vi.fn(),
}));
import { useTreeStore } from "../lib/useTreeStore";

function renderDot() {
  return render(
    <TooltipProvider>
      <ConnectionStatusDot />
    </TooltipProvider>,
  );
}

describe("<ConnectionStatusDot />", () => {
  afterEach(cleanup);

  it("renders amber when status=connecting", () => {
    (useTreeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (sel: (s: { connectionStatus: string }) => unknown) =>
        sel({ connectionStatus: "connecting" }),
    );
    renderDot();
    const dot = screen.getByTestId("connection-status-dot");
    expect(dot).toHaveAttribute("data-status", "connecting");
    expect(dot.getAttribute("style")).toMatch(/warning|f59e0b/);
  });

  it("renders green when status=connected", () => {
    (useTreeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (sel: (s: { connectionStatus: string }) => unknown) =>
        sel({ connectionStatus: "connected" }),
    );
    renderDot();
    const dot = screen.getByTestId("connection-status-dot");
    expect(dot).toHaveAttribute("data-status", "connected");
    expect(dot.getAttribute("style")).toMatch(/success|22c55e/);
  });

  it("renders amber when status=reconnecting", () => {
    (useTreeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (sel: (s: { connectionStatus: string }) => unknown) =>
        sel({ connectionStatus: "reconnecting" }),
    );
    renderDot();
    const dot = screen.getByTestId("connection-status-dot");
    expect(dot).toHaveAttribute("data-status", "reconnecting");
  });

  it("has aria-label including the status string", () => {
    (useTreeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (sel: (s: { connectionStatus: string }) => unknown) =>
        sel({ connectionStatus: "connected" }),
    );
    renderDot();
    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "Connection: connected",
    );
  });

  it("has a 24x24/padding-4 icon-like footprint (UAT #2)", () => {
    (useTreeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (sel: (s: { connectionStatus: string }) => unknown) =>
        sel({ connectionStatus: "connected" }),
    );
    renderDot();
    const footprint = screen.getByTestId("connection-status-dot")
      .parentElement as HTMLElement;
    expect(footprint.style.width).toBe("24px");
    expect(footprint.style.height).toBe("24px");
    expect(footprint.style.padding).toBe("4px");
  });

  it("shows a Tooltip describing the connection state instead of a native title (UAT #2)", () => {
    (useTreeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (sel: (s: { connectionStatus: string }) => unknown) =>
        sel({ connectionStatus: "reconnecting" }),
    );
    renderDot();
    const dot = screen.getByTestId("connection-status-dot");
    expect(dot).not.toHaveAttribute("title");
    const footprint = dot.parentElement as HTMLElement;
    fireEvent.focus(footprint);
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
  });
});
