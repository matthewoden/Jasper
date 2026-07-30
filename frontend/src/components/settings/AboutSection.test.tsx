/**
 * AboutSection.test — fetch-on-visible gating (D-23), all six facts, the
 * zero-count-is-not-an-error rule, the non-looping error state, and the
 * copy/reveal controls.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../lib/useConfig";
import { TooltipProvider } from "../Tooltip";
import type { SectionProps } from "./types";

vi.mock("../../lib/vaultAboutApi", () => ({
  getVaultAbout: vi.fn(),
}));

const revealVaultRootMock = vi.fn();
vi.mock("../../lib/useReveal", () => ({
  useReveal: () => ({ reveal: vi.fn(), revealVaultRoot: revealVaultRootMock, loading: false }),
}));

const toastSpy = vi.fn();
vi.mock("../toast.utils", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

import { getVaultAbout } from "../../lib/vaultAboutApi";
import { AboutSection } from "./AboutSection";

const mockedGetVaultAbout = vi.mocked(getVaultAbout);

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
  mockedGetVaultAbout.mockReset();
  revealVaultRootMock.mockReset();
  toastSpy.mockReset();
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("AboutSection", () => {
  it("does not fetch while visible is false", () => {
    mockedGetVaultAbout.mockResolvedValue({ data: sampleAbout });
    renderSection(false);
    expect(mockedGetVaultAbout).toHaveBeenCalledTimes(0);
  });

  it("fetches when visible flips to true", async () => {
    mockedGetVaultAbout.mockResolvedValue({ data: sampleAbout });
    const { rerender } = render(
      <TooltipProvider>
        <AboutSection {...sectionProps} visible={false} />
      </TooltipProvider>,
    );
    expect(mockedGetVaultAbout).toHaveBeenCalledTimes(0);

    rerender(
      <TooltipProvider>
        <AboutSection {...sectionProps} visible={true} />
      </TooltipProvider>,
    );
    await waitFor(() => {
      expect(mockedGetVaultAbout).toHaveBeenCalledTimes(1);
    });
  });

  it("refetches on toggling false -> true -> false -> true (exactly 2 calls)", async () => {
    mockedGetVaultAbout.mockResolvedValue({ data: sampleAbout });
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
    await waitFor(() => expect(mockedGetVaultAbout).toHaveBeenCalledTimes(1));

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
    await waitFor(() => expect(mockedGetVaultAbout).toHaveBeenCalledTimes(2));
  });

  it("renders all six rows on success", async () => {
    mockedGetVaultAbout.mockResolvedValue({ data: sampleAbout });
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
    mockedGetVaultAbout.mockResolvedValue({ data: { ...sampleAbout, noteCount: 0 } });
    renderSection(true);

    await waitFor(() => {
      expect(screen.getByText("my-vault")).toBeInTheDocument();
    });
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("renders the exact error copy with a retry control that refetches on click", async () => {
    mockedGetVaultAbout.mockResolvedValueOnce({
      error: { code: "internal_error", message: "boom", status: 500 },
    });
    renderSection(true);

    await waitFor(() => {
      expect(screen.getByText("Couldn't load vault details. Try again.")).toBeInTheDocument();
    });

    mockedGetVaultAbout.mockResolvedValueOnce({ data: sampleAbout });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByText("my-vault")).toBeInTheDocument();
    });
    expect(mockedGetVaultAbout).toHaveBeenCalledTimes(2);
  });

  it("copy button has accessible name 'Copy vault path' and writes the path to the clipboard", async () => {
    mockedGetVaultAbout.mockResolvedValue({ data: sampleAbout });
    renderSection(true);

    const copyButton = await screen.findByRole("button", { name: "Copy vault path" });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(sampleAbout.path);
    });
  });

  it("reveal button calls revealVaultRoot", async () => {
    mockedGetVaultAbout.mockResolvedValue({ data: sampleAbout });
    renderSection(true);

    const revealButton = await screen.findByRole("button", { name: "Show in file manager" });
    fireEvent.click(revealButton);

    expect(revealVaultRootMock).toHaveBeenCalledTimes(1);
  });
});
