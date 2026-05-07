import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionStatusDot } from "./ConnectionStatusDot";

vi.mock("../lib/useTreeStore", () => ({
  useTreeStore: vi.fn(),
}));
import { useTreeStore } from "../lib/useTreeStore";

describe("<ConnectionStatusDot />", () => {
  afterEach(cleanup);

  it("renders amber when status=connecting", () => {
    (useTreeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (sel: (s: { connectionStatus: string }) => unknown) =>
        sel({ connectionStatus: "connecting" }),
    );
    render(<ConnectionStatusDot />);
    const dot = screen.getByTestId("connection-status-dot");
    expect(dot).toHaveAttribute("data-status", "connecting");
    expect(dot.getAttribute("style")).toMatch(/warning|f59e0b/);
  });

  it("renders green when status=connected", () => {
    (useTreeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (sel: (s: { connectionStatus: string }) => unknown) =>
        sel({ connectionStatus: "connected" }),
    );
    render(<ConnectionStatusDot />);
    const dot = screen.getByTestId("connection-status-dot");
    expect(dot).toHaveAttribute("data-status", "connected");
    expect(dot.getAttribute("style")).toMatch(/success|22c55e/);
    expect(dot).toHaveAttribute("title", "Connected");
  });

  it("renders amber when status=reconnecting", () => {
    (useTreeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (sel: (s: { connectionStatus: string }) => unknown) =>
        sel({ connectionStatus: "reconnecting" }),
    );
    render(<ConnectionStatusDot />);
    const dot = screen.getByTestId("connection-status-dot");
    expect(dot).toHaveAttribute("data-status", "reconnecting");
    expect(dot).toHaveAttribute("title", "Reconnecting…");
  });

  it("has aria-label including the status string", () => {
    (useTreeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (sel: (s: { connectionStatus: string }) => unknown) =>
        sel({ connectionStatus: "connected" }),
    );
    render(<ConnectionStatusDot />);
    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "Connection: connected",
    );
  });
});
