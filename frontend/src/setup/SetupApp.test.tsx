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

// jsdom defines `window.location` with non-configurable properties, so a
// plain `vi.spyOn(window.location, "assign")` throws "Cannot redefine
// property". Replace `window.location` wholesale with a mutable stub for
// the duration of these tests and restore in afterEach.
const realLocation = window.location;
const locationAssignMock = vi.fn();

// ---- Module mocks (must be declared before importing SetupApp) ----
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

// Helper: drive DataDirSection through to a "valid" verdict by typing
// into the path input and resolving the mocked validate response.
async function makeDataDirValid() {
  // The validate endpoint POSTs to /setup/validate-data-dir; the wizard
  // shares one client mock so we configure POST per-call below in each
  // test. This helper waits for the debounce + validation to flow
  // through and the "Start Jasper" button to enable.
  const input = screen.getByLabelText(
    "Data directory path",
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "~/JasperNotes" } });
  // Advance time past the 300ms debounce.
  await act(async () => {
    vi.advanceTimersByTime(350);
  });
  // Wait for the validation Promise to resolve + state to flush.
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

  // Replace window.location with a mutable stub. `defineProperty` lets us
  // get past jsdom's non-configurable default. The stub forwards everything
  // we don't override to the real location so unrelated code (e.g.
  // window.location.pathname reads) keeps working.
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
    // h1
    expect(
      screen.getByRole("heading", { level: 1, name: "Set up Jasper" }),
    ).toBeInTheDocument();
    // subtitle (locked copy)
    expect(
      screen.getByText(/A few choices and you're writing/),
    ).toBeInTheDocument();
    // 4 section eyebrows
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
    // First POST = validate-data-dir (called by DataDirSection on type).
    // Second POST = the actual /setup submit. Sequence via mockImplementation.
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

    // Hit the CTA.
    fireEvent.click(screen.getByRole("button", { name: "Start Jasper" }));
    await waitFor(() => {
      expect(locationAssignMock).toHaveBeenCalledWith("/");
    });

    // Draft must be cleared BEFORE redirect (D-10).
    expect(localStorage.getItem(SETUP_DRAFT_KEY)).toBeNull();

    // Submit payload shape: assert the second POST call was /setup.
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
      // LOCKED prefix
      expect(
        screen.getByText(/Couldn't finish setup:/),
      ).toBeInTheDocument();
    });
    // LOCKED suffix
    expect(
      screen.getByText(/Check the log file and try again\./),
    ).toBeInTheDocument();
    // Button re-enables so the user can retry.
    expect(button.disabled).toBe(false);
  });
});

describe("SetupApp — theme live preview", () => {
  it("flips <html data-theme> when the Light radio is selected", () => {
    render(<SetupApp />);
    // Default state — theme starts at "dark" per DEFAULT_DRAFT.
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(screen.getByLabelText("Light"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    fireEvent.click(screen.getByLabelText("Dark"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
