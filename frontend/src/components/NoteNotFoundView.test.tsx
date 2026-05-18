/**
 * NoteNotFoundView.test — LOCKED-copy + CTA wiring.
 *
 * Coverage:
 *   - Heading "This note doesn't exist" rendered
 *   - Subtitle echoes the inline-quoted query when ?query is present
 *   - Subtitle falls back when ?query is absent
 *   - "Search notes" CTA navigates to /?search=<query>
 *   - "Open today's note" CTA calls useDailyNote.openToday
 *   - "Show file tree" CTA navigates to /
 *   - Footer fine-print "renames-resilient links" rendered
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const openTodayMock = vi.fn(async () => undefined);

vi.mock("../lib/useDailyNote", () => ({
  useDailyNote: () => ({ openToday: openTodayMock, isLoading: false }),
}));

import { NoteNotFoundView } from "./NoteNotFoundView";

// jsdom's window.location.assign is non-configurable; we swap the whole
// location object with a plain stub on each test (same pattern as
// useDeepLink.test.ts).
const originalLocation = window.location;
let assignSpy: ReturnType<typeof vi.fn>;

function setLocationWithQuery(query: string): void {
  const search = query ? `?query=${encodeURIComponent(query)}` : "";
  const url = new URL("http://localhost/note-not-found" + search);
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      href: url.href,
      origin: url.origin,
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      ancestorOrigins: {} as DOMStringList,
      assign: assignSpy,
      reload: () => {},
      replace: () => {},
      toString: () => url.href,
    } as unknown as Location,
  });
}

beforeEach(() => {
  openTodayMock.mockReset();
  openTodayMock.mockResolvedValue(undefined);
  assignSpy = vi.fn();
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe("NoteNotFoundView", () => {
  it("NNF-1: renders the LOCKED heading 'This note doesn't exist'", () => {
    setLocationWithQuery("");
    render(<NoteNotFoundView />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This note doesn't exist",
    );
  });

  it("NNF-2: subtitle echoes the inline-quoted query when ?query is present", () => {
    setLocationWithQuery("foo-bar-uuid");
    render(<NoteNotFoundView />);
    expect(
      screen.getByText(/Jasper couldn't find a note matching "foo-bar-uuid"/),
    ).toBeInTheDocument();
  });

  it("NNF-3: subtitle falls back to generic copy when ?query is absent", () => {
    setLocationWithQuery("");
    render(<NoteNotFoundView />);
    expect(
      screen.getByText(/Jasper couldn't find that note/),
    ).toBeInTheDocument();
  });

  it("NNF-4: 'Search notes' CTA navigates to /?search=<query>", () => {
    setLocationWithQuery("alpha");
    render(<NoteNotFoundView />);
    fireEvent.click(screen.getByRole("button", { name: "Search notes" }));
    expect(assignSpy).toHaveBeenCalledWith("/?search=alpha");
  });

  it("NNF-5: 'Open today's note' CTA calls useDailyNote.openToday and then navigates to /", async () => {
    setLocationWithQuery("");
    render(<NoteNotFoundView />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open today's note" }),
    );
    await waitFor(() => expect(openTodayMock).toHaveBeenCalled());
    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith("/"));
  });

  it("NNF-6: 'Show file tree' CTA navigates to /", () => {
    setLocationWithQuery("");
    render(<NoteNotFoundView />);
    fireEvent.click(screen.getByRole("button", { name: "Show file tree" }));
    expect(assignSpy).toHaveBeenCalledWith("/");
  });

  it("NNF-7: footer fine-print mentions ?note=<id> rename-resilience", () => {
    setLocationWithQuery("");
    render(<NoteNotFoundView />);
    expect(
      screen.getByText(/renames-resilient links/),
    ).toBeInTheDocument();
  });

  it("NNF-8: pressing Enter in the search input triggers Search notes navigation", () => {
    setLocationWithQuery("beta");
    render(<NoteNotFoundView />);
    const input = screen.getByLabelText("Search notes") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(assignSpy).toHaveBeenCalledWith("/?search=beta");
  });
});
