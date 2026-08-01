/**
 * AboutSection.test — fetch-on-visible gating (D-23), all six facts, the
 * zero-count-is-not-an-error rule, the non-looping error state, the
 * copy/reveal controls, and the D-15 cache-hit-on-reopen behavior.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../lib/useConfig";
import { TooltipProvider } from "../Tooltip";
import type { SectionProps } from "./types";

// vi.hoisted keeps `mockFetcher` addressable both inside the vi.mock
// factory below (hoisted above these imports) and in this file's test
// bodies.
const { mockFetcher } = vi.hoisted(() => ({ mockFetcher: vi.fn() }));

// The mocked module builds vaultAboutResource on the REAL createResource
// primitive with mockFetcher standing in for the network call, so
// read()-joining and cache-hit-on-resubscribe (D-15's "reopening a panel
// is free") are exercised for real rather than reimplemented as a second,
// divergent test double.
vi.mock("../../lib/vaultAboutApi", async () => {
  const { createResource } = await import("../../lib/resources");
  return {
    vaultAboutResource: createResource("vaultAbout", mockFetcher, {
      mode: "cached",
      invalidatedBy: [
        "note:created",
        "note:deleted",
        "note:moved",
        "folder:created",
        "folder:deleted",
        "folder:moved",
        "mcp:grant_changed",
        "reindex:complete",
      ],
    }),
  };
});

const revealVaultRootMock = vi.fn();
vi.mock("../../lib/useReveal", () => ({
  useReveal: () => ({ reveal: vi.fn(), revealVaultRoot: revealVaultRootMock, loading: false }),
}));

const toastSpy = vi.fn();
vi.mock("../toast.utils", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

import { __testing__ as resourcesTesting } from "../../lib/resources/createResource";
import { AboutSection } from "./AboutSection";

function makeConfig(): Config {
  return {
    appName: "Jasper",
    theme: "dark",
    accent: "purple",
    readingFont: "sans",
    dailyNotes: { template: "" },
    editor: {
      fontSize: 15,
      lineHeight: 1.6,
      autosaveMs: 2000,
      showProperties: true,
      autoPair: true,
      foldGutter: true,
      lineNumbers: false,
      lineWidth: 700,
    },
  } as Config;
}

const sectionProps: SectionProps = {
  config: makeConfig(),
  saveConfig: vi.fn().mockResolvedValue({}),
  onSaveError: vi.fn(),
};

const sampleAbout = {
  vaultName: "my-vault",
  noteCount: 42,
  folderCount: 5,
  path: "/Users/me/.jasper/vaults/my-vault",
  appVersion: "1.4.0",
  mcpPort: 6684,
  mcpGrantCount: 2,
};

function renderSection(visible: boolean) {
  return render(
    <TooltipProvider>
      <AboutSection {...sectionProps} visible={visible} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  mockFetcher.mockReset();
  resourcesTesting.reset();
  revealVaultRootMock.mockReset();
  toastSpy.mockReset();
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("AboutSection", () => {
  it("does not fetch while visible is false", () => {
    mockFetcher.mockResolvedValue({ data: sampleAbout });
    renderSection(false);
    expect(mockFetcher).toHaveBeenCalledTimes(0);
  });

  it("fetches when visible flips to true", async () => {
    mockFetcher.mockResolvedValue({ data: sampleAbout });
    const { rerender } = render(
      <TooltipProvider>
        <AboutSection {...sectionProps} visible={false} />
      </TooltipProvider>,
    );
    expect(mockFetcher).toHaveBeenCalledTimes(0);

    rerender(
      <TooltipProvider>
        <AboutSection {...sectionProps} visible={true} />
      </TooltipProvider>,
    );
    await waitFor(() => {
      expect(mockFetcher).toHaveBeenCalledTimes(1);
    });
  });

  it("does not refetch on toggling false -> true -> false -> true — reopening a panel is a cache hit (D-15)", async () => {
    mockFetcher.mockResolvedValue({ data: sampleAbout });
    const { rerender } = render(
      <TooltipProvider>
        <AboutSection {...sectionProps} visible={false} />
      </TooltipProvider>,
    );

    rerender(
      <TooltipProvider>
        <AboutSection {...sectionProps} visible={true} />
      </TooltipProvider>,
    );
    await waitFor(() => expect(mockFetcher).toHaveBeenCalledTimes(1));

    rerender(
      <TooltipProvider>
        <AboutSection {...sectionProps} visible={false} />
      </TooltipProvider>,
    );
    rerender(
      <TooltipProvider>
        <AboutSection {...sectionProps} visible={true} />
      </TooltipProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("my-vault")).toBeInTheDocument();
    });
    expect(mockFetcher).toHaveBeenCalledTimes(1);
  });

  it("renders all six rows on success", async () => {
    mockFetcher.mockResolvedValue({ data: sampleAbout });
    renderSection(true);

    await waitFor(() => {
      expect(screen.getByText("my-vault")).toBeInTheDocument();
    });
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText(sampleAbout.path)).toBeInTheDocument();
    expect(screen.getByText("1.4.0")).toBeInTheDocument();
    expect(screen.getByText("Port 6684 · 2 writable path(s)")).toBeInTheDocument();
  });

  it("renders a resolved noteCount of 0 as '0', not a placeholder", async () => {
    mockFetcher.mockResolvedValue({ data: { ...sampleAbout, noteCount: 0 } });
    renderSection(true);

    await waitFor(() => {
      expect(screen.getByText("my-vault")).toBeInTheDocument();
    });
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("renders the exact error copy with a retry control that refetches on click", async () => {
    mockFetcher.mockResolvedValueOnce({
      error: { code: "internal_error", message: "boom", status: 500 },
    });
    renderSection(true);

    await waitFor(() => {
      expect(screen.getByText("Couldn't load vault details. Try again.")).toBeInTheDocument();
    });

    mockFetcher.mockResolvedValueOnce({ data: sampleAbout });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByText("my-vault")).toBeInTheDocument();
    });
    expect(mockFetcher).toHaveBeenCalledTimes(2);
  });

  it("copy button has accessible name 'Copy vault path' and writes the path to the clipboard", async () => {
    mockFetcher.mockResolvedValue({ data: sampleAbout });
    renderSection(true);

    const copyButton = await screen.findByRole("button", { name: "Copy vault path" });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(sampleAbout.path);
    });
  });

  it("reveal button calls revealVaultRoot", async () => {
    mockFetcher.mockResolvedValue({ data: sampleAbout });
    renderSection(true);

    const revealButton = await screen.findByRole("button", { name: "Show in file manager" });
    fireEvent.click(revealButton);

    expect(revealVaultRootMock).toHaveBeenCalledTimes(1);
  });
});
