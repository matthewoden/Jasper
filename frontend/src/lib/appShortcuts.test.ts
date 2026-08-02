import { describe, it, expect, vi, beforeEach } from "vitest";

const putWorkspaceMock = vi.fn().mockResolvedValue({});
vi.mock("./workspaceApi", () => ({
  putWorkspace: (...args: unknown[]) => putWorkspaceMock(...args),
}));

import {
  handleAppAltT,
  handleAppBookmarkToggle,
  handleAppCmdB,
  handleAppCmdDot,
  handleAppCmdI,
  handleAppCmdO,
  handleAppCmdP,
  handleAppCmdShiftF,
  handleAppFocusNextPane,
  handleAppFocusPrevPane,
  handleAppPanelShortcuts,
  handleAppSidebarToggle,
  handleAppSplitDown,
  handleAppSplitRight,
  subscribeAppShortcut,
  type AppShortcutEvent,
} from "./appShortcuts";
import { useTreeStore } from "./useTreeStore";
import { usePaneStore } from "./usePaneStore";

describe("handleAppAltT (tab-new)", () => {
  it("dispatches 'newTab' and preventDefaults on plain Alt+T", () => {
    const received: AppShortcutEvent[] = [];
    const unsubscribe = subscribeAppShortcut((ev) => received.push(ev));
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
    const received: AppShortcutEvent[] = [];
    const unsubscribe = subscribeAppShortcut((ev) => received.push(ev));
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
    const received: AppShortcutEvent[] = [];
    const unsubscribe = subscribeAppShortcut((ev) => received.push(ev));
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
    const received: AppShortcutEvent[] = [];
    const unsubscribe = subscribeAppShortcut((ev) => received.push(ev));
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
    const received: AppShortcutEvent[] = [];
    const unsubscribe = subscribeAppShortcut((ev) => received.push(ev));
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

describe("handleAppCmdShiftF (re-point)", () => {
  beforeEach(() => {
    useTreeStore.setState({
      sidebarPanel: "notes",
      notesSidebarVisible: false,
    });
  });

  it("opens the sidebar to the Search panel and dispatches 'focusSearch'", async () => {
    const received: AppShortcutEvent[] = [];
    const unsubscribe = subscribeAppShortcut((ev) => received.push(ev));
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
      // Dispatch is deferred one frame past this handler (SidebarSearchPanel
      // may mount and subscribe in this same tick; see appShortcuts.ts).
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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
    const received: AppShortcutEvent[] = [];
    const unsubscribe = subscribeAppShortcut((ev) => received.push(ev));
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

describe("handleAppSidebarToggle (NAV-03)", () => {
  beforeEach(() => {
    useTreeStore.setState({ notesSidebarVisible: true });
  });

  it("Cmd+Shift+E flips notesSidebarVisible false and preventDefaults/stopPropagates", () => {
    const e = new KeyboardEvent("keydown", { key: "e", metaKey: true, shiftKey: true });
    const preventDefault = vi.spyOn(e, "preventDefault");
    const stopPropagation = vi.spyOn(e, "stopPropagation");
    handleAppSidebarToggle(e);
    expect(useTreeStore.getState().notesSidebarVisible).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("a second Cmd+Shift+E flips notesSidebarVisible back on", () => {
    handleAppSidebarToggle(
      new KeyboardEvent("keydown", { key: "e", metaKey: true, shiftKey: true }),
    );
    expect(useTreeStore.getState().notesSidebarVisible).toBe(false);
    handleAppSidebarToggle(
      new KeyboardEvent("keydown", { key: "E", metaKey: true, shiftKey: true }),
    );
    expect(useTreeStore.getState().notesSidebarVisible).toBe(true);
  });

  it("Ctrl+Shift+E (non-Mac) also toggles", () => {
    handleAppSidebarToggle(
      new KeyboardEvent("keydown", { key: "e", ctrlKey: true, shiftKey: true }),
    );
    expect(useTreeStore.getState().notesSidebarVisible).toBe(false);
  });

  it("no-ops without the Shift modifier", () => {
    handleAppSidebarToggle(new KeyboardEvent("keydown", { key: "e", metaKey: true }));
    expect(useTreeStore.getState().notesSidebarVisible).toBe(true);
  });

  it("no-ops without Cmd/Ctrl", () => {
    handleAppSidebarToggle(new KeyboardEvent("keydown", { key: "e", shiftKey: true }));
    expect(useTreeStore.getState().notesSidebarVisible).toBe(true);
  });
});

describe("handleAppBookmarkToggle (BOOK-01)", () => {
  it("Cmd+Shift+B dispatches 'bookmarkCurrent' and preventDefaults/stopPropagates", () => {
    const received: AppShortcutEvent[] = [];
    const unsubscribe = subscribeAppShortcut((ev) => received.push(ev));
    try {
      const e = new KeyboardEvent("keydown", {
        key: "b",
        metaKey: true,
        shiftKey: true,
      });
      const preventDefault = vi.spyOn(e, "preventDefault");
      const stopPropagation = vi.spyOn(e, "stopPropagation");
      handleAppBookmarkToggle(e);
      expect(received).toEqual(["bookmarkCurrent"]);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(stopPropagation).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it("Ctrl+Shift+B (non-Mac) also dispatches", () => {
    const received: AppShortcutEvent[] = [];
    const unsubscribe = subscribeAppShortcut((ev) => received.push(ev));
    try {
      handleAppBookmarkToggle(
        new KeyboardEvent("keydown", { key: "B", ctrlKey: true, shiftKey: true }),
      );
      expect(received).toEqual(["bookmarkCurrent"]);
    } finally {
      unsubscribe();
    }
  });

  it("no-ops without the Shift modifier", () => {
    const received: AppShortcutEvent[] = [];
    const unsubscribe = subscribeAppShortcut((ev) => received.push(ev));
    try {
      handleAppBookmarkToggle(
        new KeyboardEvent("keydown", { key: "b", metaKey: true }),
      );
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("no-ops without Cmd/Ctrl", () => {
    const received: AppShortcutEvent[] = [];
    const unsubscribe = subscribeAppShortcut((ev) => received.push(ev));
    try {
      handleAppBookmarkToggle(
        new KeyboardEvent("keydown", { key: "b", shiftKey: true }),
      );
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});

describe("handleAppCmdB / handleAppCmdI shift-exclusion", () => {
  it("handleAppCmdB does NOT preventDefault on Cmd+Shift+B (owned by handleAppBookmarkToggle)", () => {
    const e = new KeyboardEvent("keydown", {
      key: "B",
      metaKey: true,
      shiftKey: true,
    });
    const preventDefault = vi.spyOn(e, "preventDefault");
    handleAppCmdB(e);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("handleAppCmdB still preventDefaults on plain Cmd+B (outside the editor)", () => {
    const e = new KeyboardEvent("keydown", { key: "b", metaKey: true });
    const preventDefault = vi.spyOn(e, "preventDefault");
    handleAppCmdB(e);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("handleAppCmdI does NOT preventDefault on Cmd+Shift+I", () => {
    const e = new KeyboardEvent("keydown", {
      key: "I",
      metaKey: true,
      shiftKey: true,
    });
    const preventDefault = vi.spyOn(e, "preventDefault");
    handleAppCmdI(e);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("handleAppCmdI still preventDefaults on plain Cmd+I (outside the editor)", () => {
    const e = new KeyboardEvent("keydown", { key: "i", metaKey: true });
    const preventDefault = vi.spyOn(e, "preventDefault");
    handleAppCmdI(e);
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});

describe("handleAppPanelShortcuts (TAGS-01 re-point onto the rightPanel tab slice)", () => {
  beforeEach(() => {
    putWorkspaceMock.mockClear();
    useTreeStore.setState({
      rightPanel: "outline",
      backlinksRailExpanded: false,
    });
  });

  it("Cmd+Alt+T selects the Tags tab and reveals the rail when collapsed", () => {
    const e = new KeyboardEvent("keydown", {
      key: "t",
      code: "KeyT",
      altKey: true,
      metaKey: true,
    });
    const preventDefault = vi.spyOn(e, "preventDefault");
    handleAppPanelShortcuts(e);
    expect(useTreeStore.getState().rightPanel).toBe("tags");
    expect(useTreeStore.getState().backlinksRailExpanded).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(putWorkspaceMock).toHaveBeenCalledWith({ rightPanel: "tags" });
  });

  it("REGRESSION: macOS Cmd+Option+T (key:'†', code:'KeyT') still selects the Tags tab", () => {
    // On macOS, Option transforms the key value even with Cmd held —
    // Option+T reports key:"†" while code stays "KeyT". Matching e.key
    // made this shortcut dead on the project's primary platform.
    handleAppPanelShortcuts(
      new KeyboardEvent("keydown", {
        key: "†",
        code: "KeyT",
        altKey: true,
        metaKey: true,
      }),
    );
    expect(useTreeStore.getState().rightPanel).toBe("tags");
    expect(useTreeStore.getState().backlinksRailExpanded).toBe(true);
  });

  it("REGRESSION: macOS Cmd+Option+B (key:'∫', code:'KeyB') still selects the Linked-mentions tab", () => {
    handleAppPanelShortcuts(
      new KeyboardEvent("keydown", {
        key: "∫",
        code: "KeyB",
        altKey: true,
        metaKey: true,
      }),
    );
    expect(useTreeStore.getState().rightPanel).toBe("backlinks");
    expect(useTreeStore.getState().backlinksRailExpanded).toBe(true);
  });

  it("Cmd+Alt+T on the already-active Tags tab collapses the rail instead of re-selecting", () => {
    useTreeStore.setState({ rightPanel: "tags", backlinksRailExpanded: true });
    handleAppPanelShortcuts(
      new KeyboardEvent("keydown", {
        key: "t",
        code: "KeyT",
        altKey: true,
        metaKey: true,
      }),
    );
    expect(useTreeStore.getState().rightPanel).toBe("tags");
    expect(useTreeStore.getState().backlinksRailExpanded).toBe(false);
    expect(putWorkspaceMock).not.toHaveBeenCalled();
  });

  it("Cmd+Alt+B selects the Linked-mentions tab and reveals the rail when collapsed", () => {
    handleAppPanelShortcuts(
      new KeyboardEvent("keydown", {
        key: "b",
        code: "KeyB",
        altKey: true,
        metaKey: true,
      }),
    );
    expect(useTreeStore.getState().rightPanel).toBe("backlinks");
    expect(useTreeStore.getState().backlinksRailExpanded).toBe(true);
    expect(putWorkspaceMock).toHaveBeenCalledWith({ rightPanel: "backlinks" });
  });

  it("no-ops on Alt+T without Cmd/Ctrl (leaves tab-new shortcut untouched)", () => {
    handleAppPanelShortcuts(
      new KeyboardEvent("keydown", { key: "t", code: "KeyT", altKey: true }),
    );
    expect(useTreeStore.getState().rightPanel).toBe("outline");
  });
});

describe("handleAppCmdK is retired (QUICK-04 — two-role palette)", () => {
  beforeEach(() => {
    useTreeStore.setState({ paletteOpen: false, paletteMode: "notes" });
  });

  it("Cmd+K is unbound: dispatching a Cmd+K keydown leaves the palette closed and mode unchanged", () => {
    const e = new KeyboardEvent("keydown", { key: "k", metaKey: true });
    window.dispatchEvent(e);
    expect(useTreeStore.getState().paletteOpen).toBe(false);
    expect(useTreeStore.getState().paletteMode).not.toBe("all");
    expect(useTreeStore.getState().paletteMode).toBe("notes");
  });

  it("Ctrl+K (non-Mac) is also unbound", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "K", ctrlKey: true }));
    expect(useTreeStore.getState().paletteOpen).toBe(false);
    expect(useTreeStore.getState().paletteMode).toBe("notes");
  });
});

describe("handleAppCmdO (QUICK-04 — notes quick switcher)", () => {
  beforeEach(() => {
    useTreeStore.setState({ paletteOpen: false, paletteMode: "commands" });
  });

  it("Cmd+O sets mode 'notes' and opens the palette, preventDefaults/stopPropagates", () => {
    const e = new KeyboardEvent("keydown", { key: "o", metaKey: true });
    const preventDefault = vi.spyOn(e, "preventDefault");
    const stopPropagation = vi.spyOn(e, "stopPropagation");
    handleAppCmdO(e);
    expect(useTreeStore.getState().paletteMode).toBe("notes");
    expect(useTreeStore.getState().paletteOpen).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("no-ops without Cmd/Ctrl", () => {
    handleAppCmdO(new KeyboardEvent("keydown", { key: "o" }));
    expect(useTreeStore.getState().paletteOpen).toBe(false);
  });
});

describe("handleAppCmdP (QUICK-04 — command palette)", () => {
  beforeEach(() => {
    useTreeStore.setState({ paletteOpen: false, paletteMode: "notes" });
  });

  it("Cmd+P sets mode 'commands' and opens the palette, preventDefaults/stopPropagates", () => {
    const e = new KeyboardEvent("keydown", { key: "p", metaKey: true });
    const preventDefault = vi.spyOn(e, "preventDefault");
    const stopPropagation = vi.spyOn(e, "stopPropagation");
    handleAppCmdP(e);
    expect(useTreeStore.getState().paletteMode).toBe("commands");
    expect(useTreeStore.getState().paletteOpen).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("no-ops without Cmd/Ctrl", () => {
    handleAppCmdP(new KeyboardEvent("keydown", { key: "p" }));
    expect(useTreeStore.getState().paletteOpen).toBe(false);
  });
});

describe("handleAppCmdDot (zen toggle)", () => {
  beforeEach(() => {
    useTreeStore.setState({ zen: false });
  });

  it("Cmd+. toggles zen on, preventDefaults/stopPropagates", () => {
    const e = new KeyboardEvent("keydown", { key: ".", metaKey: true });
    const preventDefault = vi.spyOn(e, "preventDefault");
    const stopPropagation = vi.spyOn(e, "stopPropagation");
    handleAppCmdDot(e);
    expect(useTreeStore.getState().zen).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("a second Cmd+. flips zen back off", () => {
    handleAppCmdDot(new KeyboardEvent("keydown", { key: ".", metaKey: true }));
    expect(useTreeStore.getState().zen).toBe(true);
    handleAppCmdDot(new KeyboardEvent("keydown", { key: ".", metaKey: true }));
    expect(useTreeStore.getState().zen).toBe(false);
  });

  it("no-ops without Cmd/Ctrl", () => {
    handleAppCmdDot(new KeyboardEvent("keydown", { key: "." }));
    expect(useTreeStore.getState().zen).toBe(false);
  });
});

describe("split-right/split-down/focus-cycle-pane shortcuts", () => {
  beforeEach(() => {
    usePaneStore.getState().clearAll();
  });

  it("Cmd+\\ splits the active pane right (row)", () => {
    const splitSpy = vi.spyOn(usePaneStore.getState(), "splitActivePane");
    const e = new KeyboardEvent("keydown", { key: "\\", metaKey: true });
    const preventDefault = vi.spyOn(e, "preventDefault");
    handleAppSplitRight(e);
    expect(splitSpy).toHaveBeenCalledWith("row");
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("Ctrl+\\ (non-Mac) also splits right", () => {
    const splitSpy = vi.spyOn(usePaneStore.getState(), "splitActivePane");
    handleAppSplitRight(new KeyboardEvent("keydown", { key: "\\", ctrlKey: true }));
    expect(splitSpy).toHaveBeenCalledWith("row");
  });

  it("Cmd+\\ does NOT fire split-right when Shift is held (reserved for split-down)", () => {
    const splitSpy = vi.spyOn(usePaneStore.getState(), "splitActivePane");
    handleAppSplitRight(
      new KeyboardEvent("keydown", { key: "\\", metaKey: true, shiftKey: true }),
    );
    expect(splitSpy).not.toHaveBeenCalled();
  });

  it("Cmd+\\ no-ops when the event target is an input (do-not-hijack-typing)", () => {
    const splitSpy = vi.spyOn(usePaneStore.getState(), "splitActivePane");
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      const e = new KeyboardEvent("keydown", { key: "\\", metaKey: true });
      Object.defineProperty(e, "target", { value: input });
      handleAppSplitRight(e);
      expect(splitSpy).not.toHaveBeenCalled();
    } finally {
      input.remove();
    }
  });

  it("Cmd+Shift+\\ splits the active pane down (col)", () => {
    const splitSpy = vi.spyOn(usePaneStore.getState(), "splitActivePane");
    const e = new KeyboardEvent("keydown", {
      key: "\\",
      metaKey: true,
      shiftKey: true,
    });
    const preventDefault = vi.spyOn(e, "preventDefault");
    handleAppSplitDown(e);
    expect(splitSpy).toHaveBeenCalledWith("col");
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("Cmd+\\ (no Shift) does NOT fire split-down", () => {
    const splitSpy = vi.spyOn(usePaneStore.getState(), "splitActivePane");
    handleAppSplitDown(new KeyboardEvent("keydown", { key: "\\", metaKey: true }));
    expect(splitSpy).not.toHaveBeenCalled();
  });

  it("Cmd+Alt+Right cycles focus to the next pane", () => {
    const focusSpy = vi.spyOn(usePaneStore.getState(), "focusCyclePane");
    const e = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      metaKey: true,
      altKey: true,
    });
    const preventDefault = vi.spyOn(e, "preventDefault");
    handleAppFocusNextPane(e);
    expect(focusSpy).toHaveBeenCalledWith(1);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("Cmd+Alt+Left cycles focus to the previous pane", () => {
    const focusSpy = vi.spyOn(usePaneStore.getState(), "focusCyclePane");
    const e = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      metaKey: true,
      altKey: true,
    });
    const preventDefault = vi.spyOn(e, "preventDefault");
    handleAppFocusPrevPane(e);
    expect(focusSpy).toHaveBeenCalledWith(-1);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("Cmd+Right (no Alt) does NOT fire focus-next-pane", () => {
    const focusSpy = vi.spyOn(usePaneStore.getState(), "focusCyclePane");
    handleAppFocusNextPane(
      new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true }),
    );
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("focus-next-pane no-ops when the event target is a textarea (do-not-hijack-typing)", () => {
    const focusSpy = vi.spyOn(usePaneStore.getState(), "focusCyclePane");
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    try {
      const e = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        metaKey: true,
        altKey: true,
      });
      Object.defineProperty(e, "target", { value: textarea });
      handleAppFocusNextPane(e);
      expect(focusSpy).not.toHaveBeenCalled();
    } finally {
      textarea.remove();
    }
  });
});
