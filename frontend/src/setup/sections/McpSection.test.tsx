/**
 * Tests for McpSection — specifically the client-side path validator
 * (`isValidGrantFolderPath`) and the inline error path when the user
 * provides an unsafe folder via window.prompt.
 *
 * The validator must reject:
 *   - empty / whitespace-only
 *   - `..` substring (path traversal)
 *   - leading `/` (POSIX absolute)
 *   - Windows drive-letter absolute (`C:\` / `D:/`)
 *   - non-ASCII characters (regex: /[^\x20-\x7E]/)
 *
 * The render test verifies that when an invalid prompt result comes back,
 * the grants array is NOT mutated and an inline error message becomes
 * visible (no alert(), no throw — wizard stays interactive).
 *
 * Plan 08-04 Task 1.
 */
import {
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { McpSection } from "./McpSection";
import { isValidGrantFolderPath } from "./mcpSection.utils";
import type { SetupGrantDraft } from "../draft";

describe("isValidGrantFolderPath", () => {
  it("accepts a simple relative folder", () => {
    expect(isValidGrantFolderPath("projects")).toBe(true);
  });

  it("accepts a nested relative path", () => {
    expect(isValidGrantFolderPath("scratch/2026")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidGrantFolderPath("")).toBe(false);
  });

  it("rejects whitespace-only input", () => {
    expect(isValidGrantFolderPath("   ")).toBe(false);
  });

  it("rejects `..` traversal", () => {
    expect(isValidGrantFolderPath("../etc/passwd")).toBe(false);
  });

  it("rejects a nested `..` segment", () => {
    expect(isValidGrantFolderPath("projects/../etc")).toBe(false);
  });

  it("rejects a POSIX absolute path", () => {
    expect(isValidGrantFolderPath("/etc/passwd")).toBe(false);
  });

  it("rejects a Windows drive-letter absolute path with backslash", () => {
    expect(isValidGrantFolderPath("C:\\Users\\x")).toBe(false);
  });

  it("rejects a Windows drive-letter absolute path with forward slash", () => {
    expect(isValidGrantFolderPath("D:/Users/x")).toBe(false);
  });

  it("rejects non-ASCII characters (accented letter)", () => {
    expect(isValidGrantFolderPath("projects/é")).toBe(false);
  });

  it("rejects non-ASCII characters (zero-width)", () => {
    // U+200B zero-width space embedded in a benign-looking string.
    expect(isValidGrantFolderPath("notes​")).toBe(false);
  });
});

describe("McpSection — render integration", () => {
  // Vitest's vi.spyOn type is fussy about indexing the Window interface
  // for `prompt`. Stash the spy as `unknown` and narrow when we call
  // mockReturnValue / mockRestore — the runtime behavior is identical.
  let promptSpy: { mockReturnValue: (v: string | null) => void; mockRestore: () => void };

  beforeEach(() => {
    promptSpy = vi.spyOn(window, "prompt") as unknown as typeof promptSpy;
  });

  afterEach(() => {
    promptSpy.mockRestore();
  });

  function renderWith(initial: SetupGrantDraft[]) {
    const onGrantsChange = vi.fn();
    const onEnabledChange = vi.fn();
    const utils = render(
      <McpSection
        enabled={true}
        grants={initial}
        onEnabledChange={onEnabledChange}
        onGrantsChange={onGrantsChange}
      />,
    );
    return { ...utils, onGrantsChange, onEnabledChange };
  }

  it("rejects an invalid prompt result and shows the locked error copy", () => {
    promptSpy.mockReturnValue("../etc");
    const { onGrantsChange } = renderWith([]);

    fireEvent.click(screen.getByText("Add folder…"));

    // No mutation to the grants list.
    expect(onGrantsChange).not.toHaveBeenCalled();
    // Locked error copy is visible.
    expect(
      screen.getByText(/Invalid folder path\./),
    ).toBeInTheDocument();
  });

  it("accepts a valid prompt result and appends a Tier 1 grant", () => {
    promptSpy.mockReturnValue("projects");
    const { onGrantsChange } = renderWith([]);

    fireEvent.click(screen.getByText("Add folder…"));

    expect(onGrantsChange).toHaveBeenCalledTimes(1);
    expect(onGrantsChange).toHaveBeenCalledWith([
      { folder: "projects", level: 1 },
    ]);
    // No error message visible after success.
    expect(screen.queryByText(/Invalid folder path/)).toBeNull();
  });

  it("ignores Cancel (prompt returns null) without an error message", () => {
    promptSpy.mockReturnValue(null);
    const { onGrantsChange } = renderWith([]);

    fireEvent.click(screen.getByText("Add folder…"));

    expect(onGrantsChange).not.toHaveBeenCalled();
    expect(screen.queryByText(/Invalid folder path/)).toBeNull();
  });

  it("renders the empty-state copy when grants are empty", () => {
    promptSpy.mockReturnValue(null);
    renderWith([]);
    expect(
      screen.getByText(/No folders granted yet\. \(Reads are global once MCP is on\.\)/),
    ).toBeInTheDocument();
  });

  // ── Duplicate-guard tests (UAT-1 N8 layer 1) ──────────────────────────
  // handleAddFolder must reject a folder that already exists in the grants
  // list (exact match, case-insensitive, whitespace-trimmed) with the
  // locked error copy. onGrantsChange must NOT be called.

  it("dup_exact: rejects exact duplicate folder and shows locked error copy", () => {
    promptSpy.mockReturnValue("ai-zone");
    const { onGrantsChange } = renderWith([{ folder: "ai-zone", level: 1 }]);

    fireEvent.click(screen.getByText("Add folder…"));

    expect(onGrantsChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("alert"),
    ).toHaveTextContent("Folder already granted. Remove it first to change its tier.");
  });

  it("dup_case_insensitive: rejects case-insensitive duplicate folder", () => {
    promptSpy.mockReturnValue("AI-Zone");
    const { onGrantsChange } = renderWith([{ folder: "ai-zone", level: 1 }]);

    fireEvent.click(screen.getByText("Add folder…"));

    expect(onGrantsChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("alert"),
    ).toHaveTextContent("Folder already granted. Remove it first to change its tier.");
  });

  it("dup_whitespace: rejects whitespace-padded duplicate folder", () => {
    promptSpy.mockReturnValue("  ai-zone  ");
    const { onGrantsChange } = renderWith([{ folder: "ai-zone", level: 1 }]);

    fireEvent.click(screen.getByText("Add folder…"));

    expect(onGrantsChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("alert"),
    ).toHaveTextContent("Folder already granted. Remove it first to change its tier.");
  });

  it("unique_passes: accepts a folder not already in the grants list", () => {
    promptSpy.mockReturnValue("projects");
    const { onGrantsChange } = renderWith([{ folder: "ai-zone", level: 1 }]);

    fireEvent.click(screen.getByText("Add folder…"));

    expect(onGrantsChange).toHaveBeenCalledTimes(1);
    expect(onGrantsChange).toHaveBeenCalledWith([
      { folder: "ai-zone", level: 1 },
      { folder: "projects", level: 1 },
    ]);
  });
});
