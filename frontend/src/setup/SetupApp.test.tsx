/**
 * Tests for SetupApp — the /setup wizard root.
 *
 * Coverage:
 *   - All 4 section headings (DATA DIRECTORY · REQUIRED, THEME, AI ACCESS (MCP), DAILY NOTES) render.
 *   - LOCKED copy strings present (Set up Jasper / Start Jasper / subtitle).
 *   - "Start Jasper" CTA is disabled until DataDirSection reports valid=true.
 *   - On a successful submit (mocked client.POST returns 200), the wizard:
 *       * calls clearDraft()
 *       * calls window.location.assign("/")
 *   - On a failed submit (mocked client.POST returns 500), the error banner
 *     renders the LOCKED prefix copy ("Couldn't finish setup:") + suffix
 *     ("Check the log file and try again.").
 *   - Theme radio click updates <html data-theme>.
 *
 * Mocks:
 *   - ../api/client.client.{POST,GET} via vi.mock (same pattern as
 *     dailyNoteApi.test.ts) so no real network calls fly.
 *   - window.location.assign via vi.spyOn (jsdom defaults are read-only;
 *     spyOn replaces the method while keeping the rest of the object intact).
 *
 * Plan 08-04 Task 2.
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
    expect(screen.getByText("THEME")).toBeInTheDocument();
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

describe("SetupApp — theme live preview", () => {
  it("flips <html data-theme> when the Light radio is selected", () => {
    render(<SetupApp />);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(screen.getByLabelText("Light"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    fireEvent.click(screen.getByLabelText("Dark"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
