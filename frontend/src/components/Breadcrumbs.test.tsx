/**
 * Breadcrumbs tests — T1..T9.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTreeStore } from "../lib/useTreeStore";


const mockExpandAndScrollToFolder = vi.fn();
vi.mock("./fileTree.utils", () => ({
  expandAndScrollToFolder: (...args: unknown[]) =>
    mockExpandAndScrollToFolder(...args),
}));


const mockUseFileTree = vi.fn();
vi.mock("../lib/useFileTree", () => ({
  useFileTree: () => mockUseFileTree(),
}));


vi.mock("../lib/useReveal", () => ({
  useReveal: () => ({ reveal: vi.fn(), loading: false }),
}));

import { Breadcrumbs } from "./Breadcrumbs";


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
    const separators = screen.getAllByText("/");
    expect(separators.length).toBe(2);
  });
});
