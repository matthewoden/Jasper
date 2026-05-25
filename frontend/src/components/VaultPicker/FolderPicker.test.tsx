/**
 * FolderPicker tests — breadcrumb navigation + double-click "type a path" flow.
 *
 * The Radix Dialog renders into a portal mounted on document.body. happy-dom
 * supports portals out of the box, so we don't need a custom container.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

import type { FsListResponse } from "../../lib/fsApi";

const listMock = vi.fn();
vi.mock("../../lib/fsApi", () => ({
  fsApi: { list: (...args: unknown[]) => listMock(...args) },
}));

import { FolderPicker } from "./FolderPicker";

function ok(resp: FsListResponse) {
  return Promise.resolve(resp);
}

const HOME_RESP: FsListResponse = {
  path: "/Users/me",
  parent: "/Users",
  entries: [
    { name: "Documents", path: "/Users/me/Documents" },
    { name: "Projects", path: "/Users/me/Projects" },
  ],
};

const DOCS_RESP: FsListResponse = {
  path: "/Users/me/Documents",
  parent: "/Users/me",
  entries: [{ name: "Notes", path: "/Users/me/Documents/Notes" }],
};

describe("<FolderPicker /> breadcrumb edit mode (UAT-2 #1d type-a-path)", () => {
  beforeEach(() => {
    listMock.mockReset();
  });

  it("renders breadcrumb segments after initial load", async () => {
    listMock.mockReturnValueOnce(ok(HOME_RESP));
    render(<FolderPicker open onSelect={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    const crumb = await screen.findByTestId("folder-picker-breadcrumb");
    // / › Users › me
    expect(within(crumb).getByRole("button", { name: "/" })).toBeInTheDocument();
    expect(within(crumb).getByRole("button", { name: "Users" })).toBeInTheDocument();
    expect(within(crumb).getByRole("button", { name: "me" })).toBeInTheDocument();
  });

  it("double-click on breadcrumb (non-segment) swaps to a typed input pre-filled with current path", async () => {
    listMock.mockReturnValueOnce(ok(HOME_RESP));
    render(<FolderPicker open onSelect={vi.fn()} onCancel={vi.fn()} />);
    const crumb = await screen.findByTestId("folder-picker-breadcrumb");

    // Double-click the bar itself (not a segment button).
    fireEvent.doubleClick(crumb);

    const input = await screen.findByTestId("folder-picker-path-input");
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("/Users/me");
    // Breadcrumb is gone while editing.
    expect(screen.queryByTestId("folder-picker-breadcrumb")).toBeNull();
  });

  it("double-click on a breadcrumb segment button does NOT open edit mode (it navigates)", async () => {
    listMock.mockReturnValueOnce(ok(HOME_RESP)).mockReturnValueOnce(ok(DOCS_RESP));
    render(<FolderPicker open onSelect={vi.fn()} onCancel={vi.fn()} />);
    const crumb = await screen.findByTestId("folder-picker-breadcrumb");
    const segment = within(crumb).getByRole("button", { name: "Users" });

    fireEvent.doubleClick(segment);

    // Edit input must NOT have appeared — the double-click on the segment is
    // accidental clicking, not a request to type a path.
    expect(screen.queryByTestId("folder-picker-path-input")).toBeNull();
    expect(screen.getByTestId("folder-picker-breadcrumb")).toBeInTheDocument();
  });

  it("Enter on the input loads the typed path and reverts to breadcrumb on success", async () => {
    listMock.mockReturnValueOnce(ok(HOME_RESP)).mockReturnValueOnce(ok(DOCS_RESP));
    render(<FolderPicker open onSelect={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.doubleClick(await screen.findByTestId("folder-picker-breadcrumb"));
    const input = await screen.findByTestId("folder-picker-path-input");
    fireEvent.change(input, { target: { value: "/Users/me/Documents" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(listMock).toHaveBeenLastCalledWith("/Users/me/Documents");
    });
    // After successful load, edit mode exits → breadcrumb is back.
    await waitFor(() => {
      expect(screen.queryByTestId("folder-picker-path-input")).toBeNull();
    });
    const crumb = await screen.findByTestId("folder-picker-breadcrumb");
    expect(within(crumb).getByRole("button", { name: "Documents" })).toBeInTheDocument();
  });

  it("Enter with an invalid path keeps the input open and surfaces the error", async () => {
    listMock
      .mockReturnValueOnce(ok(HOME_RESP))
      // Use mockImplementationOnce so the rejected promise is created at call
      // time — `mockReturnValueOnce(Promise.reject(...))` constructs the
      // rejection eagerly and trips Node's unhandled-rejection detector before
      // load()'s try/catch attaches.
      .mockImplementationOnce(() => Promise.reject(new Error("no such directory: /nope")));
    render(<FolderPicker open onSelect={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.doubleClick(await screen.findByTestId("folder-picker-breadcrumb"));
    const input = await screen.findByTestId("folder-picker-path-input");
    fireEvent.change(input, { target: { value: "/nope" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByTestId("folder-picker-error")).toHaveTextContent(/no such directory/i),
    );
    // Input stays so the user can fix the typo without re-engaging the breadcrumb.
    expect(screen.getByTestId("folder-picker-path-input")).toBeInTheDocument();
  });

  it("Escape on the input cancels edit mode without loading", async () => {
    listMock.mockReturnValueOnce(ok(HOME_RESP));
    render(<FolderPicker open onSelect={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.doubleClick(await screen.findByTestId("folder-picker-breadcrumb"));
    const input = await screen.findByTestId("folder-picker-path-input");
    fireEvent.change(input, { target: { value: "/some/typo" } });

    const callsBeforeEscape = listMock.mock.calls.length;
    fireEvent.keyDown(input, { key: "Escape" });

    // No second list() call should fire on cancel.
    expect(listMock.mock.calls.length).toBe(callsBeforeEscape);
    // Breadcrumb is back, input is gone.
    expect(await screen.findByTestId("folder-picker-breadcrumb")).toBeInTheDocument();
    expect(screen.queryByTestId("folder-picker-path-input")).toBeNull();
  });
});
