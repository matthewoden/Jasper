/**
 * Tests for the MCP Unavailable Banner (D-05).
 *
 * Validates:
 *   - Renders nothing when mcp is undefined (older/empty admin/status response)
 *   - Renders nothing when mcp.up === true
 *   - Renders "AI tools unavailable" + reason copy when mcp.up === false
 *   - Falls back to generic port-6684 copy when reason is absent
 *   - Dismiss hides the banner for this session (local state)
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { McpUnavailableBanner } from "./McpUnavailableBanner";
import type {
  MigrationState,
  UseMigrationStatusResult,
} from "../lib/useMigrationStatus";

function makeStatus(
  overrides: Partial<UseMigrationStatusResult> & { state?: MigrationState },
): UseMigrationStatusResult {
  return {
    state: overrides.state ?? "ok",
    failedMigration: overrides.failedMigration,
    logsPath: overrides.logsPath,
    notesIndexed: overrides.notesIndexed,
    mcp: overrides.mcp,
    loading: overrides.loading ?? false,
    error: overrides.error ?? null,
    refresh: overrides.refresh ?? vi.fn(),
  };
}

describe("<McpUnavailableBanner />", () => {
  it("MB1: renders nothing when mcp is undefined", () => {
    render(<McpUnavailableBanner status={makeStatus({})} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("MB2: renders nothing when mcp.up === true", () => {
    render(
      <McpUnavailableBanner status={makeStatus({ mcp: { up: true } })} />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("MB3: renders 'AI tools unavailable' with the reason when mcp.up === false", () => {
    render(
      <McpUnavailableBanner
        status={makeStatus({
          mcp: { up: false, reason: "port 6684 in use" },
        })}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("AI tools unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "port 6684 in use — AI read/write tools are disabled this session.",
      ),
    ).toBeInTheDocument();
  });

  it("MB4: falls back to generic port-6684 copy when reason is absent", () => {
    render(
      <McpUnavailableBanner status={makeStatus({ mcp: { up: false } })} />,
    );
    expect(
      screen.getByText(
        "Port 6684 in use — AI read/write tools are disabled this session.",
      ),
    ).toBeInTheDocument();
  });

  it("MB5: clicking Dismiss hides the banner (session-local)", () => {
    render(
      <McpUnavailableBanner
        status={makeStatus({ mcp: { up: false, reason: "port 6684 in use" } })}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("MB6: hides when mcp transitions from up=false to up=true (post-restart refresh)", () => {
    const { rerender } = render(
      <McpUnavailableBanner
        status={makeStatus({ mcp: { up: false, reason: "port 6684 in use" } })}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(<McpUnavailableBanner status={makeStatus({ mcp: { up: true } })} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
