/**
 * SettingsMenu tests — trigger-attributes (aria-label/title/data-testid E2E
 * selector contract) and clicking trigger opens SettingsDialog.
 *
 * Mock covers useConfig (used by SettingsDialog → useConfig → GET /config).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn().mockResolvedValue({
      data: {
        appName: "Jasper",
        display_name: "My Notes",
        theme: "dark",
        dailyNotes: { folder: "daily", template: "# {{date}}\n\n" },
        editor: { fontSize: 15, lineHeight: 1.6, vimMode: false, autosaveMs: 2000 },
      },
      response: { status: 200 },
    }),
    PUT: vi.fn().mockResolvedValue({ data: {}, response: { status: 200 } }),
  },
}));

import { SettingsMenu } from "./SettingsMenu";

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
  vi.clearAllMocks();
});

describe("<SettingsMenu />", () => {
  it("renders the trigger button with locked aria-label + title", () => {
    render(<SettingsMenu />);
    const btn = screen.getByTestId("settings-menu-trigger");
    expect(btn).toHaveAttribute("aria-label", "Settings");
    expect(btn).toHaveAttribute("title", "Settings");
  });

  it("clicking trigger opens the Settings dialog", async () => {
    const user = userEvent.setup();
    render(<SettingsMenu />);
    await user.click(screen.getByTestId("settings-menu-trigger"));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });
});
