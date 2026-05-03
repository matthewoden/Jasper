/**
 * SidebarToolbar tests — UI-SPEC §Surface 6.
 *
 * Locked button order + tooltip copy:
 *   1. New note (FilePlus)
 *   2. New folder (FolderPlus)
 *   3. Refresh (RefreshCw)  — title="Refresh — pick up external file changes"
 *
 * Refresh button shows animate-spin + disabled while in-flight; PreventsConcurrentClicks.
 * Native title= attribute (Phase 1 deferral pattern; Phase 4 swaps to Radix Tooltip).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SidebarToolbar } from "./SidebarToolbar";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("<SidebarToolbar />", () => {
  it("TestToolbar_RendersThreeButtons", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        onRefresh={() => Promise.resolve()}
      />,
    );
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("TestToolbar_NewNote_OnClick", () => {
    const onNewNote = vi.fn();
    render(
      <SidebarToolbar
        onNewNote={onNewNote}
        onNewFolder={vi.fn()}
        onRefresh={() => Promise.resolve()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(onNewNote).toHaveBeenCalledTimes(1);
  });

  it("TestToolbar_NewFolder_OnClick", () => {
    const onNewFolder = vi.fn();
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={onNewFolder}
        onRefresh={() => Promise.resolve()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    expect(onNewFolder).toHaveBeenCalledTimes(1);
  });

  it("TestToolbar_Refresh_OnClick_TriggersInFlightSpin", async () => {
    const d = deferred();
    const onRefresh = vi.fn(() => d.promise);
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        onRefresh={onRefresh}
      />,
    );
    const btn = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
    // Icon receives animate-spin during in-flight.
    const icon = btn.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("class") ?? "").toMatch(/animate-spin/);
    // Button is disabled while in flight.
    expect(btn).toBeDisabled();
    // Resolve to clean up.
    await act(async () => {
      d.resolve();
      await d.promise;
    });
  });

  it("TestToolbar_Refresh_StopsSpinOnSuccess", async () => {
    const d = deferred();
    const onRefresh = vi.fn(() => d.promise);
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        onRefresh={onRefresh}
      />,
    );
    const btn = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(btn).toBeDisabled();
    });
    await act(async () => {
      d.resolve();
      await d.promise;
    });
    await waitFor(() => {
      expect(btn).not.toBeDisabled();
    });
    const icon = btn.querySelector("svg");
    expect(icon?.getAttribute("class") ?? "").not.toMatch(/animate-spin/);
  });

  it("TestToolbar_Refresh_StopsSpinOnError", async () => {
    const d = deferred();
    const onRefresh = vi.fn(() => d.promise);
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        onRefresh={onRefresh}
      />,
    );
    const btn = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(btn).toBeDisabled();
    });
    await act(async () => {
      d.reject(new Error("boom"));
      // swallow the rejection — the toolbar's catch handler clears spin.
      try {
        await d.promise;
      } catch {
        /* expected */
      }
    });
    await waitFor(() => {
      expect(btn).not.toBeDisabled();
    });
    const icon = btn.querySelector("svg");
    expect(icon?.getAttribute("class") ?? "").not.toMatch(/animate-spin/);
  });

  it("TestToolbar_Refresh_PreventsConcurrentClicks", async () => {
    const d = deferred();
    const onRefresh = vi.fn(() => d.promise);
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        onRefresh={onRefresh}
      />,
    );
    const btn = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(btn).toBeDisabled();
    });
    // Second click should be a no-op (button disabled OR guard inside handler).
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      d.resolve();
      await d.promise;
    });
  });

  it("TestToolbar_NativeTooltips: locked title= text on each button", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        onRefresh={() => Promise.resolve()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "New note" }).getAttribute("title"),
    ).toBe("New note");
    expect(
      screen.getByRole("button", { name: "New folder" }).getAttribute("title"),
    ).toBe("New folder");
    expect(
      screen.getByRole("button", { name: "Refresh" }).getAttribute("title"),
    ).toBe("Refresh — pick up external file changes");
  });
});
