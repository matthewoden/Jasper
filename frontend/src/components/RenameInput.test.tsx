/**
 * RenameInput tests — UI-SPEC §Surface 3 inline rename.
 *
 * Verifies validation rules (empty / illegal char / collision),
 * Enter / Esc / Tab / click-outside key handling, and server-error
 * fallback (when onCommit throws TreeMutationError, the input stays
 * mounted with the inline error rendered from the server message).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TreeMutationError } from "../lib/useTreeMutations";
import { RenameInput, validateRename } from "./RenameInput";

describe("validateRename — pure validation function", () => {
  it("accepts a normal name", () => {
    expect(validateRename("scratchpad", []).valid).toBe(true);
  });

  it("rejects empty", () => {
    const r = validateRename("", []);
    expect(r.valid).toBe(false);
    expect(r.error).toBe("Name cannot be empty.");
  });

  it("rejects illegal char (slash)", () => {
    const r = validateRename("a/b", []);
    expect(r.valid).toBe(false);
    expect(r.error).toBe(
      "Use letters, numbers, dashes, and underscores only.",
    );
  });

  it("rejects collision (case-insensitive)", () => {
    const r = validateRename("FOO", ["foo"]);
    expect(r.valid).toBe(false);
    expect(r.error).toBe("Already exists.");
  });
});

describe("<RenameInput />", () => {
  it("TestRename_RendersWithInitialValue", () => {
    render(
      <RenameInput
        initialValue="scratchpad"
        isFolder={false}
        siblingNames={[]}
        onCommit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("scratchpad");
  });

  it("TestRename_FullTextSelectedOnMount", () => {
    // jsdom supports input.select() — check selectionStart/End
    render(
      <RenameInput
        initialValue="scratchpad"
        isFolder={false}
        siblingNames={[]}
        onCommit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("scratchpad".length);
  });

  it("TestRename_TypeIllegalChar_ShowsError", () => {
    render(
      <RenameInput
        initialValue="ok"
        isFolder={false}
        siblingNames={[]}
        onCommit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "a/b" } });
    expect(
      screen.getByText("Use letters, numbers, dashes, and underscores only."),
    ).toBeInTheDocument();
    // The input has destructive border
    expect(input.style.borderColor).toContain("destructive");
  });

  it("TestRename_Empty_ShowsEmptyError", () => {
    render(
      <RenameInput
        initialValue="ok"
        isFolder={false}
        siblingNames={[]}
        onCommit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText("Name cannot be empty.")).toBeInTheDocument();
  });

  it("TestRename_Collision_ShowsCollisionError", () => {
    render(
      <RenameInput
        initialValue="ok"
        isFolder={false}
        siblingNames={["foo"]}
        onCommit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "FOO" } });
    expect(screen.getByText("Already exists.")).toBeInTheDocument();
  });

  it("TestRename_Enter_CommitsValidValue", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameInput
        initialValue="ok"
        isFolder={false}
        siblingNames={[]}
        onCommit={onCommit}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "valid" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledWith("valid");
    });
  });

  it("TestRename_Enter_DisabledOnInvalid", () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameInput
        initialValue="ok"
        isFolder={false}
        siblingNames={[]}
        onCommit={onCommit}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("TestRename_Esc_Cancels", () => {
    const onCancel = vi.fn();
    render(
      <RenameInput
        initialValue="ok"
        isFolder={false}
        siblingNames={[]}
        onCommit={vi.fn().mockResolvedValue(undefined)}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("TestRename_Tab_Commits", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameInput
        initialValue="ok"
        isFolder={false}
        siblingNames={[]}
        onCommit={onCommit}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "valid" } });
    fireEvent.keyDown(input, { key: "Tab" });
    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledWith("valid");
    });
  });

  it("TestRename_ClickOutside_Commits", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    render(
      <div>
        <RenameInput
          initialValue="ok"
          isFolder={false}
          siblingNames={[]}
          onCommit={onCommit}
          onCancel={vi.fn()}
        />
        <button data-testid="outside">outside</button>
      </div>,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "valid" } });
    // Click outside via mousedown event on document (matches RenameInput
    // listener pattern).
    fireEvent.mouseDown(screen.getByTestId("outside"));
    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledWith("valid");
    });
  });

  it("TestRename_OnCommit_ServerError_StaysOpen", async () => {
    const onCommit = vi
      .fn()
      .mockRejectedValue(
        new TreeMutationError("case_collision", "server says nope", 409),
      );
    render(
      <RenameInput
        initialValue="ok"
        isFolder={false}
        siblingNames={[]}
        onCommit={onCommit}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "valid" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(onCommit).toHaveBeenCalled();
    });
    // Input still mounted
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    // Server error message rendered as inline error
    await waitFor(() => {
      expect(screen.getByText(/server says nope/)).toBeInTheDocument();
    });
    // Border destructive
    const inp = screen.getByRole("textbox") as HTMLInputElement;
    expect(inp.style.borderColor).toContain("destructive");
  });
});
