/**
 * Breadcrumbs tests — Phase 06.6-07. UAT-updated 2026-05-12: the leading
 * "notes" root segment was dropped, so the segment-count + separator-count
 * expectations decrement by one.
 *
 * Covers:
 *   T1: no active note → renders nothing
 *   T2: root-level note → renders just "note-title" (no separators, no buttons)
 *   T3: nested note → renders "folder / subfolder / note-title"
 *   T4: folder segments are <button> with aria-label
 *   T5: clicking folder segment calls expandAndScrollToFolder + sets pulseTarget
 *   T6: final note-title segment is <span>, not <button>
 *   T7: live title from liveLabels overrides static title
 *   T8: nav has aria-label="Note path"
 *   T9: segments are separated by "/"
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTreeStore } from "../lib/useTreeStore";

// Mock expandAndScrollToFolder
const mockExpandAndScrollToFolder = vi.fn();
vi.mock("./fileTree.utils", () => ({
  expandAndScrollToFolder: (...args: unknown[]) =>
    mockExpandAndScrollToFolder(...args),
}));

// Mock useFileTree
const mockUseFileTree = vi.fn();
vi.mock("../lib/useFileTree", () => ({
  useFileTree: () => mockUseFileTree(),
}));

// Plan 08-06 (D-26): Breadcrumbs now consumes useReveal() for the folder
// segment context-menu reveal item. Mock at the module boundary to avoid
// requiring a ToastProvider wrapper around every test render — the
// reveal toast scenarios are covered by src/lib/useReveal.test.ts.
vi.mock("../lib/useReveal", () => ({
  useReveal: () => ({ reveal: vi.fn(), loading: false }),
}));

import { Breadcrumbs } from "./Breadcrumbs";

// A fixed tree for tests
const fakeTree = {
  root: [
    {
      kind: "note" as const,
      id: "note-root-uuid",
      path: "my-note.md",
      title: "My Note",
      updated_at: "2026-01-01T00:00:00Z",
    },
    {
      kind: "folder" as const,
      path: "projects",
      name: "projects",
      children: [
        {
          kind: "folder" as const,
          path: "projects/jasper",
          name: "jasper",
          children: [
            {
              kind: "note" as const,
              id: "note-deep-uuid",
              path: "projects/jasper/my-note.md",
              title: "Deep Note",
              updated_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      ],
    },
  ],
};

beforeEach(() => {
  useTreeStore.setState({
    activeNoteId: null,
    liveLabels: {},
    pulseTarget: null,
  });
  mockExpandAndScrollToFolder.mockReset();
  mockUseFileTree.mockReturnValue({
    tree: fakeTree,
    loading: false,
    error: null,
    refresh: vi.fn(),
    mutate: vi.fn(),
  });
});

describe("Breadcrumbs", () => {
  it("T1: renders nothing when activeNoteId is null", () => {
    useTreeStore.setState({ activeNoteId: null });
    const { container } = render(<Breadcrumbs />);
    expect(container.firstChild).toBeNull();
  });

  it("T2: root-level note renders just the title — no separators, no folder buttons", () => {
    useTreeStore.setState({ activeNoteId: "note-root-uuid", liveLabels: {} });
    render(<Breadcrumbs />);
    // UAT 2026-05-12: "notes" root segment removed; root note is title-only.
    expect(screen.queryByText("notes")).toBeNull();
    expect(screen.queryAllByText("/").length).toBe(0);
    expect(screen.getByText("My Note")).toBeInTheDocument();
    expect(screen.queryAllByRole("button").length).toBe(0);
  });

  it("T3: nested note renders 'projects / jasper / Deep Note' (no 'notes' prefix)", () => {
    useTreeStore.setState({ activeNoteId: "note-deep-uuid", liveLabels: {} });
    render(<Breadcrumbs />);
    expect(screen.queryByText("notes")).toBeNull();
    expect(screen.getByRole("button", { name: "Navigate to folder: projects" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Navigate to folder: jasper" })).toBeInTheDocument();
    expect(screen.getByText("Deep Note")).toBeInTheDocument();
  });

  it("T4: folder segments are buttons with aria-label 'Navigate to folder: {name}'", () => {
    useTreeStore.setState({ activeNoteId: "note-deep-uuid", liveLabels: {} });
    render(<Breadcrumbs />);
    const projectsBtn = screen.getByRole("button", {
      name: "Navigate to folder: projects",
    });
    expect(projectsBtn).toBeInTheDocument();
    const jasperBtn = screen.getByRole("button", {
      name: "Navigate to folder: jasper",
    });
    expect(jasperBtn).toBeInTheDocument();
  });

  it("T5: clicking a folder segment calls expandAndScrollToFolder AND sets pulseTarget", () => {
    useTreeStore.setState({ activeNoteId: "note-deep-uuid", liveLabels: {} });
    render(<Breadcrumbs />);
    const projectsBtn = screen.getByRole("button", {
      name: "Navigate to folder: projects",
    });
    fireEvent.click(projectsBtn);
    expect(mockExpandAndScrollToFolder).toHaveBeenCalledWith("projects");
    // UAT 2026-05-12: click also pulses the tree row briefly.
    expect(useTreeStore.getState().pulseTarget).toEqual({
      kind: "folder",
      target: "projects",
    });

    const jasperBtn = screen.getByRole("button", {
      name: "Navigate to folder: jasper",
    });
    fireEvent.click(jasperBtn);
    expect(mockExpandAndScrollToFolder).toHaveBeenCalledWith("projects/jasper");
    expect(useTreeStore.getState().pulseTarget).toEqual({
      kind: "folder",
      target: "projects/jasper",
    });
  });

  it("T6: final segment is a <span>, not a <button>", () => {
    useTreeStore.setState({ activeNoteId: "note-deep-uuid", liveLabels: {} });
    render(<Breadcrumbs />);
    const titleEl = screen.getByText("Deep Note");
    expect(titleEl.tagName.toLowerCase()).toBe("span");
    // Verify it's not a button
    expect(titleEl.closest("button")).toBeNull();
  });

  it("T7: live title from liveLabels overrides static title for final segment", () => {
    useTreeStore.setState({
      activeNoteId: "note-deep-uuid",
      liveLabels: { "note-deep-uuid": "New Title" },
    });
    render(<Breadcrumbs />);
    expect(screen.getByText("New Title")).toBeInTheDocument();
    expect(screen.queryByText("Deep Note")).toBeNull();
  });

  it("T8: nav container has aria-label='Note path'", () => {
    useTreeStore.setState({ activeNoteId: "note-deep-uuid", liveLabels: {} });
    render(<Breadcrumbs />);
    const nav = screen.getByRole("navigation", { name: "Note path" });
    expect(nav).toBeInTheDocument();
  });

  it("T9: segments are separated by '/' separators", () => {
    useTreeStore.setState({ activeNoteId: "note-deep-uuid", liveLabels: {} });
    render(<Breadcrumbs />);
    // UAT 2026-05-12: "projects / jasper / Deep Note" → 2 separators (was 3).
    const separators = screen.getAllByText("/");
    expect(separators.length).toBe(2);
  });
});
