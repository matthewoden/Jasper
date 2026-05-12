/**
 * Breadcrumbs tests — Phase 06.6-07.
 *
 * Covers:
 *   T1: no active note → renders nothing
 *   T2: root-level note → renders "notes / note-title"
 *   T3: nested note → renders "notes / folder / subfolder / note-title"
 *   T4: folder segments are <button> with aria-label
 *   T5: clicking folder segment calls expandAndScrollToFolder
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
vi.mock("./FileTree", () => ({
  expandAndScrollToFolder: (...args: unknown[]) =>
    mockExpandAndScrollToFolder(...args),
}));

// Mock useFileTree
const mockUseFileTree = vi.fn();
vi.mock("../lib/useFileTree", () => ({
  useFileTree: () => mockUseFileTree(),
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

  it("T2: root-level note renders 'notes / note-title' with no folder buttons between", () => {
    useTreeStore.setState({ activeNoteId: "note-root-uuid", liveLabels: {} });
    render(<Breadcrumbs />);
    // "notes" root segment
    expect(screen.getByText("notes")).toBeInTheDocument();
    // separator
    expect(screen.getAllByText("/").length).toBeGreaterThanOrEqual(1);
    // final title segment
    expect(screen.getByText("My Note")).toBeInTheDocument();
    // No folder buttons between root and note
    const buttons = screen.queryAllByRole("button");
    // buttons should NOT include a folder segment between notes and the note title
    // (for a root-level note, there are no folder segments at all)
    expect(buttons.length).toBe(0);
  });

  it("T3: nested note renders 'notes / projects / jasper / Deep Note'", () => {
    useTreeStore.setState({ activeNoteId: "note-deep-uuid", liveLabels: {} });
    render(<Breadcrumbs />);
    expect(screen.getByText("notes")).toBeInTheDocument();
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

  it("T5: clicking a folder segment calls expandAndScrollToFolder with the folder path", () => {
    useTreeStore.setState({ activeNoteId: "note-deep-uuid", liveLabels: {} });
    render(<Breadcrumbs />);
    const projectsBtn = screen.getByRole("button", {
      name: "Navigate to folder: projects",
    });
    fireEvent.click(projectsBtn);
    expect(mockExpandAndScrollToFolder).toHaveBeenCalledWith("projects");

    const jasperBtn = screen.getByRole("button", {
      name: "Navigate to folder: jasper",
    });
    fireEvent.click(jasperBtn);
    expect(mockExpandAndScrollToFolder).toHaveBeenCalledWith("projects/jasper");
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
    // For "notes / projects / jasper / Deep Note" there should be 3 separators
    const separators = screen.getAllByText("/");
    expect(separators.length).toBe(3);
  });
});
