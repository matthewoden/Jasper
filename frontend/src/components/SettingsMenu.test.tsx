import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn().mockResolvedValue({
      data: {
        appName: "Jasper",
        theme: "dark",
        dailyNotes: { folder: "daily", template: "" },
        editor: { fontSize: 15, lineHeight: 1.6, vimMode: false },
      },
      response: { status: 200 },
    }),
    PUT: vi.fn().mockResolvedValue({
      data: {},
      response: { status: 200 },
    }),
  },
}));

import { SettingsMenu } from "./SettingsMenu";

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
});

describe("<SettingsMenu />", () => {
  it("renders the trigger button with locked aria-label + title", () => {
    render(<SettingsMenu />);
    const btn = screen.getByTestId("settings-menu-trigger");
    expect(btn).toHaveAttribute("aria-label", "Settings");
    expect(btn).toHaveAttribute("title", "Settings");
  });

  it("opening the menu reveals the Theme group + Dark/Light options", async () => {
    const user = userEvent.setup();
    render(<SettingsMenu />);
    await user.click(screen.getByTestId("settings-menu-trigger"));
    expect(screen.getByText("Theme")).toBeDefined();
    expect(screen.getByTestId("settings-theme-dark")).toBeDefined();
    expect(screen.getByTestId("settings-theme-light")).toBeDefined();
  });

  it("Theme: Dark and Theme: Light aria-labels are present", async () => {
    const user = userEvent.setup();
    render(<SettingsMenu />);
    await user.click(screen.getByTestId("settings-menu-trigger"));
    const dark = screen.getByTestId("settings-theme-dark");
    const light = screen.getByTestId("settings-theme-light");
    expect(dark).toHaveAttribute("aria-label", "Theme: Dark");
    expect(light).toHaveAttribute("aria-label", "Theme: Light");
  });
});
