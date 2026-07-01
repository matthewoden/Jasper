/**
 * Tests for SetupApp — the /setup wizard root.
 *
 * Coverage:
 *   - All 4 section headings render.
 *   - "Start Jasper" is disabled until DataDirSection reports valid=true.
 *   - Successful submit: calls clearDraft() and window.location.assign("/").
 *   - Failed submit: shows error banner with prefix and suffix copy.
 *   - Appearance controls apply accent + reading font live (dark-only, D-01).
 *
 * client.{POST,GET} mocked via vi.mock so no real network calls fly.
 * window.location.assign spied via vi.spyOn (jsdom's location is read-only).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";


const realLocation = window.location;
const locationAssignMock = vi.fn();


const postMock = vi.fn();
const getMock = vi.fn();
vi.mock("../api/client", () => ({
  client: {
    POST: (...args: unknown[]) => postMock(...args),
    GET: (...args: unknown[]) => getMock(...args),
  },
}));

import { SetupApp } from "./SetupApp";
import { SETUP_DRAFT_KEY } from "./draft";


async function makeDataDirValid() {
  const input = screen.getByLabelText(
    "Data directory path",
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "~/JasperNotes" } });
  await act(async () => {
    vi.advanceTimersByTime(350);
  });
  await waitFor(() => {
    expect(
      (screen.getByRole("button", { name: "Start Jasper" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  postMock.mockReset();
  getMock.mockReset();
  locationAssignMock.mockReset();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");

  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...realLocation, assign: locationAssignMock },
  });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: realLocation,
  });
});

describe("SetupApp — rendering", () => {
  it("renders all 4 section eyebrows + the locked page heading + subtitle", () => {
    render(<SetupApp />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Set up Jasper" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/A few choices and you're writing/),
    ).toBeInTheDocument();
    expect(screen.getByText("DATA DIRECTORY · REQUIRED")).toBeInTheDocument();
    expect(screen.getByText("APPEARANCE")).toBeInTheDocument();
    expect(screen.getByText("AI ACCESS (MCP)")).toBeInTheDocument();
    expect(screen.getByText("DAILY NOTES")).toBeInTheDocument();
  });

  it("renders Start Jasper button disabled by default", () => {
    render(<SetupApp />);
    const button = screen.getByRole("button", {
      name: "Start Jasper",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("SetupApp — submit happy path", () => {
  it("calls submitSetup + clears the draft + redirects to / on 200", async () => {
    let postCallIdx = 0;
    postMock.mockImplementation((path: string) => {
      postCallIdx++;
      if (path === "/setup/validate-data-dir") {
        return Promise.resolve({ data: { valid: true }, error: undefined });
      }
      if (path === "/setup") {
        return Promise.resolve({ data: { ok: true }, error: undefined });
      }
      throw new Error(`unexpected POST path ${path} (#${postCallIdx})`);
    });

    render(<SetupApp />);
    await makeDataDirValid();

    fireEvent.click(screen.getByRole("button", { name: "Start Jasper" }));
    await waitFor(() => {
      expect(locationAssignMock).toHaveBeenCalledWith("/");
    });

    expect(localStorage.getItem(SETUP_DRAFT_KEY)).toBeNull();

    const setupCall = postMock.mock.calls.find((c) => c[0] === "/setup");
    expect(setupCall).toBeDefined();
    const body = (setupCall?.[1] as { body: { data_dir: string; theme: string } })
      .body;
    expect(body.data_dir).toBe("~/JasperNotes");
    expect(body.theme).toBe("dark");
  });
});

describe("SetupApp — submit failure", () => {
  it("renders the locked error copy and re-enables the button on 500", async () => {
    postMock.mockImplementation((path: string) => {
      if (path === "/setup/validate-data-dir") {
        return Promise.resolve({ data: { valid: true }, error: undefined });
      }
      if (path === "/setup") {
        return Promise.resolve({
          data: undefined,
          error: { code: "internal", message: "disk full" },
        });
      }
      throw new Error(`unexpected POST path ${path}`);
    });

    render(<SetupApp />);
    await makeDataDirValid();

    const button = screen.getByRole("button", {
      name: "Start Jasper",
    }) as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => {
      expect(
        screen.getByText(/Couldn't finish setup:/),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Check the log file and try again\./),
    ).toBeInTheDocument();
    expect(button.disabled).toBe(false);
  });
});

describe("SetupApp — appearance live preview", () => {
  it("applies the accent + reading font live (dark-only, D-01: no theme toggle)", () => {
    render(<SetupApp />);

    // Clicking the Sky swatch applies its hex to the --color-accent var immediately.
    fireEvent.click(screen.getByLabelText("Sky"));
    expect(
      document.documentElement.style.getPropertyValue("--color-accent"),
    ).toBe("#7dd3fc");

    // Selecting Serif applies the serif reading-font stack to --font-reading.
    fireEvent.click(screen.getByRole("button", { name: "Serif" }));
    expect(
      document.documentElement.style.getPropertyValue("--font-reading"),
    ).not.toBe("");

    // Dark-only: the wizard offers no light option, so it never sets data-theme
    // to anything other than dark (main.tsx pins "dark" for the /setup route).
    expect(document.documentElement.getAttribute("data-theme")).not.toBe("light");
  });
});
