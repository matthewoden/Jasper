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

// ──────────────────────────────────────────────────────────────────
// Plan 03-12 Gap 4 — RenameInput must trap key events so they do
// NOT bubble up to the tree's keymap. react-arborist listens at the
// tree-container level for first-letter-jump (alphanumerics), Enter
// (open / toggle), Escape (close), arrow keys (navigation). While
// the inline-rename input is mounted, NONE of those should fire —
// the input is the active control.
// ──────────────────────────────────────────────────────────────────

describe("key event trap (Gap 4)", () => {
  it("alphanumeric key does not bubble to parent", () => {
    const parentKeyDown = vi.fn();
    const onCommit = vi.fn(async () => {});
    const onCancel = vi.fn();
    const { getByRole } = render(
      <div onKeyDown={parentKeyDown}>
        <RenameInput
          initialValue="x"
          isFolder={false}
          siblingNames={[]}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </div>,
    );
    const input = getByRole("textbox") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "t" });
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it("Enter does not bubble to parent and commits", async () => {
    const parentKeyDown = vi.fn();
    const onCommit = vi.fn(async () => {});
    const onCancel = vi.fn();
    const { getByRole } = render(
      <div onKeyDown={parentKeyDown}>
        <RenameInput
          initialValue="hello"
          isFolder={false}
          siblingNames={[]}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </div>,
    );
    const input = getByRole("textbox") as HTMLInputElement;
    // Type a changed value so commit() takes the onCommit path
    // (the same-name short-circuit added in Plan 03-19 would otherwise
    // route to onCancel — which is also fine for the bubble check, but
    // assertion below specifically targets the commit branch).
    fireEvent.change(input, { target: { value: "hello-renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(onCommit).toHaveBeenCalledWith("hello-renamed"),
    );
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it("Escape does not bubble to parent and cancels", () => {
    const parentKeyDown = vi.fn();
    const onCommit = vi.fn(async () => {});
    const onCancel = vi.fn();
    const { getByRole } = render(
      <div onKeyDown={parentKeyDown}>
        <RenameInput
          initialValue="x"
          isFolder={false}
          siblingNames={[]}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </div>,
    );
    const input = getByRole("textbox") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it("Tab does not bubble to parent and commits", async () => {
    const parentKeyDown = vi.fn();
    const onCommit = vi.fn(async () => {});
    const onCancel = vi.fn();
    const { getByRole } = render(
      <div onKeyDown={parentKeyDown}>
        <RenameInput
          initialValue="hello"
          isFolder={false}
          siblingNames={[]}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </div>,
    );
    const input = getByRole("textbox") as HTMLInputElement;
    // Type a changed value so commit() takes the onCommit path
    // (Plan 03-19 same-name short-circuit otherwise routes to onCancel).
    fireEvent.change(input, { target: { value: "hello-renamed" } });
    fireEvent.keyDown(input, { key: "Tab" });
    await waitFor(() =>
      expect(onCommit).toHaveBeenCalledWith("hello-renamed"),
    );
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it("mousedown on the input does not bubble to parent", () => {
    const parentMouseDown = vi.fn();
    const onCommit = vi.fn(async () => {});
    const onCancel = vi.fn();
    const { getByRole } = render(
      <div onMouseDown={parentMouseDown}>
        <RenameInput
          initialValue="x"
          isFolder={false}
          siblingNames={[]}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </div>,
    );
    const input = getByRole("textbox") as HTMLInputElement;
    fireEvent.mouseDown(input);
    expect(parentMouseDown).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────
// Plan 03-19 Gap R2-5 — same-name commit is a no-op.
//
// When the user presses Enter / Tab / clicks outside without changing
// the value (or types a new value and erases back to the original),
// RenameInput must call onCancel (NOT onCommit). This avoids a
// false-positive 409 case-collision against the row's own current
// path in Service.Move (research §3.4 — the server's Move does not
// short-circuit oldRelPath == canonNew, and FileStore's collision
// check has no source-vs-destination distinction at that layer).
//
// Symmetric to Plan 03-11's computeMoveTarget same-parent guard for
// the drag path.
// ──────────────────────────────────────────────────────────────────

describe("same-name no-op short-circuit (Gap R2-5)", () => {
  it("Enter on unchanged value calls onCancel, never onCommit", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <RenameInput
        initialValue="alpha"
        isFolder={false}
        siblingNames={[]}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    // Press Enter WITHOUT typing.
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("Tab on unchanged value calls onCancel, never onCommit", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <RenameInput
        initialValue="alpha"
        isFolder={false}
        siblingNames={[]}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Tab" });
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("click-outside on unchanged value calls onCancel, never onCommit", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <div>
        <RenameInput
          initialValue="alpha"
          isFolder={false}
          siblingNames={[]}
          onCommit={onCommit}
          onCancel={onCancel}
        />
        <button data-testid="outside">outside</button>
      </div>,
    );
    fireEvent.mouseDown(screen.getByTestId("outside"));
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("typing a new value and pressing Enter still commits normally", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <RenameInput
        initialValue="alpha"
        isFolder={false}
        siblingNames={[]}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledWith("beta");
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("typing a new value then erasing back to initialValue, then Enter, calls onCancel", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <RenameInput
        initialValue="alpha"
        isFolder={false}
        siblingNames={[]}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    // Type a new value then erase back to the original.
    fireEvent.change(input, { target: { value: "alphabet" } });
    fireEvent.change(input, { target: { value: "alpha" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("empty initialValue + empty value does NOT short-circuit — empty validation still fires", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <RenameInput
        initialValue=""
        isFolder={false}
        siblingNames={[]}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.keyDown(input, { key: "Enter" });
    // The "empty" validation path runs — onCancel must NOT fire (the
    // short-circuit is gated on value !== ""), and onCommit also must
    // NOT fire (validation rejects).
    expect(onCancel).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    // The empty-validation error stays rendered.
    expect(screen.getByText("Name cannot be empty.")).toBeInTheDocument();
  });

  it("pre-existing collision validation still fires on changed-to-collide value", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <RenameInput
        initialValue="alpha"
        isFolder={false}
        siblingNames={["beta"]}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "BETA" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText("Already exists.")).toBeInTheDocument();
  });
});

// ──────────────────────────────────────────────────────────────────
// Bug D fix — isNew=true changes the same-name short-circuit in
// commit() so that Enter/Tab/blur without changing the placeholder
// name commits (keeps the file) rather than cancelling (which would
// delete the ephemeral node via TreeRow.handleCancelRename).
//
// Escape must still cancel unconditionally regardless of isNew, since
// the user explicitly pressed the cancel key — TreeRow.handleCancelRename
// handles the deletion of the ephemeral node in that path.
// ──────────────────────────────────────────────────────────────────

describe("isNew — ephemeral-node commit semantics (Bug D)", () => {
  it("Enter on unchanged placeholder name COMMITS when isNew=true", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <RenameInput
        initialValue="untitled"
        isFolder={false}
        siblingNames={[]}
        onCommit={onCommit}
        onCancel={onCancel}
        isNew={true}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledWith("untitled");
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Tab on unchanged placeholder name COMMITS when isNew=true", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <RenameInput
        initialValue="untitled"
        isFolder={false}
        siblingNames={[]}
        onCommit={onCommit}
        onCancel={onCancel}
        isNew={true}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Tab" });
    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledWith("untitled");
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("blur without change COMMITS when isNew=true", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <div>
        <RenameInput
          initialValue="untitled"
          isFolder={false}
          siblingNames={[]}
          onCommit={onCommit}
          onCancel={onCancel}
          isNew={true}
        />
        <button data-testid="outside">outside</button>
      </div>,
    );
    fireEvent.mouseDown(screen.getByTestId("outside"));
    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledWith("untitled");
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Escape CANCELS even when isNew=true (TreeRow.handleCancelRename deletes the ephemeral node)", () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <RenameInput
        initialValue="untitled"
        isFolder={false}
        siblingNames={[]}
        onCommit={onCommit}
        onCancel={onCancel}
        isNew={true}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("typing a new value and pressing Enter still commits the new value when isNew=true", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <RenameInput
        initialValue="untitled"
        isFolder={false}
        siblingNames={[]}
        onCommit={onCommit}
        onCancel={onCancel}
        isNew={true}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "my-new-note" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledWith("my-new-note");
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("isNew omitted (default false) — Enter on unchanged value still routes to onCancel (Gap R2-5 not regressed)", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <RenameInput
        initialValue="existing-note"
        isFolder={false}
        siblingNames={[]}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

