/**
 * Tests for the Surface 1 Migration Error Banner.
 *
 * Validates UI-SPEC §Surface 1 contract verbatim:
 *   - Renders nothing when state=ok (banner is server-state-driven)
 *   - Renders locked copy when state=rolled_back, with concrete filename + path
 *   - Logs-path button copies to clipboard + fires the locked toast
 *   - Reset-and-rebuild button calls the onResetConfirm prop
 *   - Dismiss hides the banner for this session (local state)
 *
 * useMigrationStatus and useToast are mocked — this test exercises the
 * banner's render/interaction surface only, NOT the hook.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockToast = vi.fn();

vi.mock("./toast.utils", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { MigrationBanner } from "./MigrationBanner";
import type {
  MigrationState,
  UseMigrationStatusResult,
} from "../lib/useMigrationStatus";

const noop = () => undefined;


function makeStatus(
  overrides: Partial<UseMigrationStatusResult> & { state: MigrationState },
): UseMigrationStatusResult {
  return {
    state: overrides.state,
    failedMigration: overrides.failedMigration,
    logsPath: overrides.logsPath,
    notesIndexed: overrides.notesIndexed,
    loading: overrides.loading ?? false,
    error: overrides.error ?? null,
    refresh: overrides.refresh ?? vi.fn(),
  };
}

describe("<MigrationBanner />", () => {
  let writeTextMock: ReturnType<typeof vi.fn>;
  let originalClipboard: typeof navigator.clipboard | undefined;

  beforeEach(() => {
    mockToast.mockReset();
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
  });

  it("MB1: renders nothing when state=ok", () => {
    render(
      <MigrationBanner
        onResetConfirm={noop}
        status={makeStatus({ state: "ok" })}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("MB2: renders the locked copy when state=rolled_back with concrete filename + path", () => {
    render(
      <MigrationBanner
        onResetConfirm={noop}
        status={makeStatus({
          state: "rolled_back",
          failedMigration: "003_tags.sql",
          logsPath: "/Users/me/.jasper/storage/logs/jasper.log",
        })}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByText("Migration 003_tags.sql failed."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Your notes are safe — the previous schema was restored."),
    ).toBeInTheDocument();
    expect(screen.getByText(/View logs:/)).toBeInTheDocument();
    expect(
      screen.getByText("/Users/me/.jasper/storage/logs/jasper.log"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reset and rebuild database" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("MB3: clicking the logs path button writes to clipboard and fires the locked toast", async () => {
    render(
      <MigrationBanner
        onResetConfirm={noop}
        status={makeStatus({
          state: "rolled_back",
          failedMigration: "003_tags.sql",
          logsPath: "/tmp/jasper.log",
        })}
      />,
    );
    const logsButton = screen.getByText("/tmp/jasper.log");
    fireEvent.click(logsButton);

    expect(writeTextMock).toHaveBeenCalledWith("/tmp/jasper.log");
    await Promise.resolve();
    expect(mockToast).toHaveBeenCalledWith({
      title: "Log path copied to clipboard.",
      durationMs: 3000,
    });
  });

  it("MB4: clicking Reset-and-rebuild calls the onResetConfirm prop", () => {
    const onResetConfirm = vi.fn();
    render(
      <MigrationBanner
        onResetConfirm={onResetConfirm}
        status={makeStatus({
          state: "rolled_back",
          failedMigration: "003.sql",
          logsPath: "/x",
        })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reset and rebuild database" }),
    );
    expect(onResetConfirm).toHaveBeenCalledTimes(1);
  });

  it("MB5: clicking Dismiss hides the banner (session-local)", () => {
    render(
      <MigrationBanner
        onResetConfirm={noop}
        status={makeStatus({
          state: "rolled_back",
          failedMigration: "003.sql",
          logsPath: "/x",
        })}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("MB6: falls back to '(unknown)' filename when failedMigration is absent", () => {
    render(
      <MigrationBanner
        onResetConfirm={noop}
        status={makeStatus({
          state: "rolled_back",
          failedMigration: undefined,
          logsPath: "/x",
        })}
      />,
    );
    expect(screen.getByText("Migration (unknown) failed.")).toBeInTheDocument();
  });

  it("MB7: renders nothing for state=rebuilding (server is mid-reindex)", () => {
    render(
      <MigrationBanner
        onResetConfirm={noop}
        status={makeStatus({ state: "rebuilding" })}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("MB8: renders nothing for state=unrecoverable (Path 3 — static error page handles UI)", () => {
    render(
      <MigrationBanner
        onResetConfirm={noop}
        status={makeStatus({ state: "unrecoverable" })}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("MB9: hides when state transitions from rolled_back to ok (post-rebuild refresh)", () => {
    const { rerender } = render(
      <MigrationBanner
        onResetConfirm={noop}
        status={makeStatus({
          state: "rolled_back",
          failedMigration: "002_break.sql",
          logsPath: "/x",
        })}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(
      <MigrationBanner
        onResetConfirm={noop}
        status={makeStatus({ state: "ok" })}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
