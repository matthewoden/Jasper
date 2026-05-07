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

  // ── Gap R2-2: in-flight guard for create buttons ─────────────────────
  // Mirrors the existing Refresh-button spin-disabled pattern. While
  // `creating === true`, both New Note and New Folder render disabled
  // with opacity 0.5 + cursor "wait", and their onClick handlers are
  // not invoked.

  it("TestToolbar_CreatingFalse_ButtonsEnabled — default state", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        onRefresh={() => Promise.resolve()}
        creating={false}
      />,
    );
    const newNote = screen.getByRole("button", { name: "New note" });
    const newFolder = screen.getByRole("button", { name: "New folder" });
    expect(newNote).not.toBeDisabled();
    expect(newFolder).not.toBeDisabled();
    expect(newNote.style.opacity).not.toBe("0.5");
    expect(newFolder.style.opacity).not.toBe("0.5");
  });

  it("TestToolbar_CreatingTrue_DisablesNewNoteAndNewFolder", () => {
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        onRefresh={() => Promise.resolve()}
        creating={true}
      />,
    );
    const newNote = screen.getByRole("button", { name: "New note" });
    const newFolder = screen.getByRole("button", { name: "New folder" });
    expect(newNote).toBeDisabled();
    expect(newFolder).toBeDisabled();
    // Visual treatment matches the Refresh button's spin-disabled pattern.
    expect(newNote.style.opacity).toBe("0.5");
    expect(newNote.style.cursor).toBe("wait");
    expect(newFolder.style.opacity).toBe("0.5");
    expect(newFolder.style.cursor).toBe("wait");
  });

  it("TestToolbar_CreatingTrue_PreventsClicks — onClick spies are not called", () => {
    const onNewNote = vi.fn();
    const onNewFolder = vi.fn();
    render(
      <SidebarToolbar
        onNewNote={onNewNote}
        onNewFolder={onNewFolder}
        onRefresh={() => Promise.resolve()}
        creating={true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    expect(onNewNote).not.toHaveBeenCalled();
    expect(onNewFolder).not.toHaveBeenCalled();
  });

  it("TestToolbar_CreatingAndRefreshing_AllThreeButtonsDisabled", async () => {
    const d = deferred();
    const onRefresh = vi.fn(() => d.promise);
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        onRefresh={onRefresh}
        creating={true}
      />,
    );
    const refreshBtn = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(refreshBtn);
    await waitFor(() => {
      expect(refreshBtn).toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "New note" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New folder" })).toBeDisabled();
    await act(async () => {
      d.resolve();
      await d.promise;
    });
  });

  it("TestToolbar_CreatingDefaultsToFalse — omitting prop keeps existing behavior", () => {
    // Existing call sites (Sidebar, App.test.tsx) that don't pass
    // `creating` must continue to render exactly as they did before.
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        onRefresh={() => Promise.resolve()}
      />,
    );
    expect(screen.getByRole("button", { name: "New note" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "New folder" })).not.toBeDisabled();
  });

  // ── Phase 4 — TREE-12: ConnectionStatusDot appended after Refresh button ────
  it("TestToolbar_RendersConnectionStatusDot", () => {
    // ConnectionStatusDot reads useTreeStore.connectionStatus (real store
    // defaults to "connecting"). The test simply asserts the dot is present.
    render(
      <SidebarToolbar
        onNewNote={vi.fn()}
        onNewFolder={vi.fn()}
        onRefresh={() => Promise.resolve()}
      />,
    );
    expect(screen.getByTestId("connection-status-dot")).toBeInTheDocument();
  });
});
