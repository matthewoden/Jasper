/**
 * App-shell tests — confirms the locked 3-column grid renders Sidebar /
 * EditorPane / BacklinksColumn in the right tracks.
 *
 * notesApi is mocked so EditorPane mounts cleanly without hitting the real
 * client (no backend in this plan).
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./lib/notesApi", () => ({
  ScratchpadUUID: "00000000-0000-4000-a000-000000000001",
  getNote: vi.fn().mockResolvedValue({
    data: {
      id: "00000000-0000-4000-a000-000000000001",
      path: "scratchpad.md",
      content: "# Welcome",
      updated_at: "2025-01-01T00:00:00Z",
    },
    error: undefined,
    response: new Response(),
  }),
  updateNote: vi.fn(),
}));

import App from "./App";

describe("<App />", () => {
  it("A1: renders the locked three-column CSS grid (260px 1fr 0)", () => {
    const { container } = render(<App />);
    const root = container.firstChild as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.style.display).toBe("grid");
    expect(root.style.gridTemplateColumns).toBe("260px 1fr 0");
    expect(root.style.minHeight).toBe("100vh");
  });

  it("A2: renders Sidebar, EditorPane, and BacklinksColumn", async () => {
    render(<App />);
    // Sidebar.
    expect(screen.getByText("NOTES")).toBeInTheDocument();
    expect(screen.getByText("scratchpad")).toBeInTheDocument();
    // EditorPane (textarea).
    const textarea = screen.getByLabelText(
      "Scratchpad note content",
    ) as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    // BacklinksColumn — aside with width 0; aria-hidden.
    const aside = document.querySelector("aside[aria-hidden]");
    expect(aside).not.toBeNull();
    // EditorPane finishes loading.
    await waitFor(() => expect(textarea).not.toBeDisabled());
  });
});
