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

  // WSL Windows-form display (UAT-2 #1d follow-up). When the backend
  // supplies windows_path on a /mnt/<drive> listing, the breadcrumb relabels
  // segments to Windows-form (C:\, Users, you, ...) and the footer shows the
  // Windows path as primary with the WSL form as the small secondary line.
  describe("WSL windows_path display", () => {
    const WSL_RESP: FsListResponse = {
      path: "/mnt/c/Users/you",
      parent: "/mnt/c/Users",
      windows_path: "C:\\Users\\you",
      entries: [
        { name: "Documents", path: "/mnt/c/Users/you/Documents" },
      ],
    };

    it("relabels breadcrumb segments to Windows form when windows_path is supplied", async () => {
      listMock.mockReturnValueOnce(ok(WSL_RESP));
      render(<FolderPicker open onSelect={vi.fn()} onCancel={vi.fn()} />);
      const crumb = await screen.findByTestId("folder-picker-breadcrumb");
      // Windows-form labels: "C:\" then "Users" then "you".
      expect(within(crumb).getByRole("button", { name: "C:\\" })).toBeInTheDocument();
      expect(within(crumb).getByRole("button", { name: "Users" })).toBeInTheDocument();
      expect(within(crumb).getByRole("button", { name: "you" })).toBeInTheDocument();
      // WSL-form root segments must NOT appear as labels in WSL mode.
      expect(within(crumb).queryByRole("button", { name: "/" })).toBeNull();
      expect(within(crumb).queryByRole("button", { name: "mnt" })).toBeNull();
      expect(within(crumb).queryByRole("button", { name: "c" })).toBeNull();
    });

    it("breadcrumb click-target stays WSL-form (the backend operates on /mnt paths)", async () => {
      listMock.mockReturnValueOnce(ok(WSL_RESP)).mockReturnValueOnce(
        ok({
          path: "/mnt/c/Users",
          parent: "/mnt/c",
          windows_path: "C:\\Users",
          entries: [],
        }),
      );
      render(<FolderPicker open onSelect={vi.fn()} onCancel={vi.fn()} />);
      const crumb = await screen.findByTestId("folder-picker-breadcrumb");
      fireEvent.click(within(crumb).getByRole("button", { name: "Users" }));
      await waitFor(() => {
        // The hop loaded the WSL path even though the user clicked the Windows label.
        expect(listMock).toHaveBeenLastCalledWith("/mnt/c/Users");
      });
    });

    it("footer shows Windows path as primary, WSL form as secondary line", async () => {
      listMock.mockReturnValueOnce(ok(WSL_RESP));
      render(<FolderPicker open onSelect={vi.fn()} onCancel={vi.fn()} />);
      const primary = await screen.findByTestId("folder-picker-current-path-primary");
      expect(primary).toHaveTextContent("C:\\Users\\you");
      const secondary = screen.getByTestId("folder-picker-current-path-secondary");
      expect(secondary).toHaveTextContent("/mnt/c/Users/you");
    });

    it("falls back to POSIX breadcrumb when windows_path is absent (non-WSL or /home/...)", async () => {
      // Same shape as WSL response BUT no windows_path → behaves like before.
      listMock.mockReturnValueOnce(
        ok({ path: "/home/me/notes", parent: "/home/me", entries: [] }),
      );
      render(<FolderPicker open onSelect={vi.fn()} onCancel={vi.fn()} />);
      const crumb = await screen.findByTestId("folder-picker-breadcrumb");
      expect(within(crumb).getByRole("button", { name: "/" })).toBeInTheDocument();
      expect(within(crumb).getByRole("button", { name: "home" })).toBeInTheDocument();
      expect(within(crumb).getByRole("button", { name: "me" })).toBeInTheDocument();
      // No secondary line when windows_path is absent.
      expect(screen.queryByTestId("folder-picker-current-path-secondary")).toBeNull();
    });
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
