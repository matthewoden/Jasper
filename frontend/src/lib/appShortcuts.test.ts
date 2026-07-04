import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleAppAltT,
  handleAppCmdShiftF,
  subscribePhase7,
  type Phase7DispatchEvent,
} from "./appShortcuts";
import { useTreeStore } from "./useTreeStore";

describe("handleAppAltT (tab-new)", () => {
  it("dispatches 'newTab' and preventDefaults on plain Alt+T", () => {
    const received: Phase7DispatchEvent[] = [];
    const unsubscribe = subscribePhase7((ev) => received.push(ev));
    try {
      const e = new KeyboardEvent("keydown", {
        key: "t",
        code: "KeyT",
        altKey: true,
      });
      const preventDefault = vi.spyOn(e, "preventDefault");
      handleAppAltT(e);
      expect(received).toEqual(["newTab"]);
      expect(preventDefault).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it("REGRESSION: macOS Option+T (key:'†', code:'KeyT') still fires newTab and preventDefaults", () => {
    // Option+T on macOS delivers the dead-key char "†" as the key value but
    // reports code:"KeyT". The old key.toLowerCase()==="t" guard missed this,
    // letting "†" type into CodeMirror. Matching e.code fixes it.
    const received: Phase7DispatchEvent[] = [];
    const unsubscribe = subscribePhase7((ev) => received.push(ev));
    try {
      const e = new KeyboardEvent("keydown", {
        key: "†",
        code: "KeyT",
        altKey: true,
      });
      const preventDefault = vi.spyOn(e, "preventDefault");
      handleAppAltT(e);
      expect(received).toEqual(["newTab"]);
      expect(preventDefault).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it("does NOT dispatch on Cmd+Alt+T (leaves Tags-panel toggle untouched)", () => {
    const received: Phase7DispatchEvent[] = [];
    const unsubscribe = subscribePhase7((ev) => received.push(ev));
    try {
      handleAppAltT(
        new KeyboardEvent("keydown", {
          key: "t",
          code: "KeyT",
          altKey: true,
          metaKey: true,
        }),
      );
      handleAppAltT(
        new KeyboardEvent("keydown", {
          key: "t",
          code: "KeyT",
          altKey: true,
          ctrlKey: true,
        }),
      );
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("does NOT dispatch on plain 't' with no modifiers", () => {
    const received: Phase7DispatchEvent[] = [];
    const unsubscribe = subscribePhase7((ev) => received.push(ev));
    try {
      handleAppAltT(new KeyboardEvent("keydown", { key: "t", code: "KeyT" }));
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("fires regardless of tab count (bootstrap path, no zero-tab bail)", () => {
    // The handler reads no tab state — proven by dispatching with a fresh
    // subscriber and asserting it fires unconditionally on the matching combo.
    const received: Phase7DispatchEvent[] = [];
    const unsubscribe = subscribePhase7((ev) => received.push(ev));
    try {
      handleAppAltT(
        new KeyboardEvent("keydown", {
          key: "T",
          code: "KeyT",
          altKey: true,
        }),
      );
      expect(received).toEqual(["newTab"]);
    } finally {
      unsubscribe();
    }
  });
});

describe("handleAppCmdShiftF (Phase 19 D-05 re-point)", () => {
  beforeEach(() => {
    useTreeStore.setState({
      sidebarPanel: "files",
      notesSidebarVisible: false,
    });
  });

  it("opens the sidebar to the Search panel and dispatches 'focusSearch' (D-05)", () => {
    const received: Phase7DispatchEvent[] = [];
    const unsubscribe = subscribePhase7((ev) => received.push(ev));
    try {
      const e = new KeyboardEvent("keydown", {
        key: "f",
        metaKey: true,
        shiftKey: true,
      });
      const preventDefault = vi.spyOn(e, "preventDefault");
      handleAppCmdShiftF(e);
      expect(useTreeStore.getState().sidebarPanel).toBe("search");
      expect(useTreeStore.getState().notesSidebarVisible).toBe(true);
      expect(received).toEqual(["focusSearch"]);
      expect(preventDefault).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it("does NOT touch the command palette (no more setPaletteMode/setPaletteOpen calls)", () => {
    useTreeStore.setState({ paletteOpen: false, paletteMode: "notes" });
    handleAppCmdShiftF(
      new KeyboardEvent("keydown", { key: "F", metaKey: true, shiftKey: true }),
    );
    expect(useTreeStore.getState().paletteOpen).toBe(false);
    expect(useTreeStore.getState().paletteMode).toBe("notes");
  });

  it("no-ops without the Shift modifier", () => {
    const received: Phase7DispatchEvent[] = [];
    const unsubscribe = subscribePhase7((ev) => received.push(ev));
    try {
      handleAppCmdShiftF(
        new KeyboardEvent("keydown", { key: "f", metaKey: true }),
      );
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});
