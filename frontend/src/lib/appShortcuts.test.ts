import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleAppAltT,
  handleAppBookmarkToggle,
  handleAppCmdB,
  handleAppCmdDot,
  handleAppCmdI,
  handleAppCmdK,
  handleAppCmdShiftF,
  handleAppFocusNextPane,
  handleAppFocusPrevPane,
  handleAppPanelShortcuts,
  handleAppSidebarToggle,
  handleAppSplitDown,
  handleAppSplitRight,
  subscribePhase7,
  type Phase7DispatchEvent,
} from "./appShortcuts";
import { useTreeStore } from "./useTreeStore";
import { usePaneStore } from "./usePaneStore";

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
      sidebarPanel: "notes",
      notesSidebarVisible: false,
    });
  });

  it("opens the sidebar to the Search panel and dispatches 'focusSearch' (D-05)", async () => {
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

describe("handleAppSidebarToggle (Phase 27 NAV-03, D-13)", () => {
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

describe("handleAppBookmarkToggle (Phase 27 BOOK-01, D-14)", () => {
  it("Cmd+Shift+B dispatches 'bookmarkCurrent' and preventDefaults/stopPropagates", () => {
    const received: Phase7DispatchEvent[] = [];
    const unsubscribe = subscribePhase7((ev) => received.push(ev));
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
    const received: Phase7DispatchEvent[] = [];
    const unsubscribe = subscribePhase7((ev) => received.push(ev));
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
    const received: Phase7DispatchEvent[] = [];
    const unsubscribe = subscribePhase7((ev) => received.push(ev));
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
    const received: Phase7DispatchEvent[] = [];
    const unsubscribe = subscribePhase7((ev) => received.push(ev));
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

describe("handleAppCmdB / handleAppCmdI shift-exclusion (WR-05)", () => {
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

describe("handleAppPanelShortcuts (Phase 20 D-01 re-point onto per-section collapse booleans)", () => {
  beforeEach(() => {
    useTreeStore.setState({
      tagsPanelExpanded: true,
      linkedMentionsPanelExpanded: true,
      backlinksRailExpanded: false,
    });
  });

  it("Cmd+Alt+T toggles tagsPanelExpanded and reveals the rail when expanding", () => {
    useTreeStore.setState({ tagsPanelExpanded: false, backlinksRailExpanded: false });
    const e = new KeyboardEvent("keydown", {
      key: "t",
      code: "KeyT",
      altKey: true,
      metaKey: true,
    });
    const preventDefault = vi.spyOn(e, "preventDefault");
    handleAppPanelShortcuts(e);
    expect(useTreeStore.getState().tagsPanelExpanded).toBe(true);
    expect(useTreeStore.getState().backlinksRailExpanded).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("REGRESSION: macOS Cmd+Option+T (key:'†', code:'KeyT') still toggles the Tags section", () => {
    // On macOS, Option transforms the key value even with Cmd held —
    // Option+T reports key:"†" while code stays "KeyT". Matching e.key
    // made this shortcut dead on the project's primary platform.
    useTreeStore.setState({ tagsPanelExpanded: false, backlinksRailExpanded: false });
    handleAppPanelShortcuts(
      new KeyboardEvent("keydown", {
        key: "†",
        code: "KeyT",
        altKey: true,
        metaKey: true,
      }),
    );
    expect(useTreeStore.getState().tagsPanelExpanded).toBe(true);
    expect(useTreeStore.getState().backlinksRailExpanded).toBe(true);
  });

  it("REGRESSION: macOS Cmd+Option+B (key:'∫', code:'KeyB') still toggles the Linked-mentions section", () => {
    useTreeStore.setState({
      linkedMentionsPanelExpanded: false,
      backlinksRailExpanded: false,
    });
    handleAppPanelShortcuts(
      new KeyboardEvent("keydown", {
        key: "∫",
        code: "KeyB",
        altKey: true,
        metaKey: true,
      }),
    );
    expect(useTreeStore.getState().linkedMentionsPanelExpanded).toBe(true);
    expect(useTreeStore.getState().backlinksRailExpanded).toBe(true);
  });

  it("Cmd+Alt+T collapsing the section does NOT force the rail open", () => {
    useTreeStore.setState({ tagsPanelExpanded: true, backlinksRailExpanded: true });
    handleAppPanelShortcuts(
      new KeyboardEvent("keydown", {
        key: "t",
        code: "KeyT",
        altKey: true,
        metaKey: true,
      }),
    );
    expect(useTreeStore.getState().tagsPanelExpanded).toBe(false);
    expect(useTreeStore.getState().backlinksRailExpanded).toBe(true);
  });

  it("Cmd+Alt+B toggles linkedMentionsPanelExpanded and reveals the rail when expanding", () => {
    useTreeStore.setState({
      linkedMentionsPanelExpanded: false,
      backlinksRailExpanded: false,
    });
    handleAppPanelShortcuts(
      new KeyboardEvent("keydown", {
        key: "b",
        code: "KeyB",
        altKey: true,
        metaKey: true,
      }),
    );
    expect(useTreeStore.getState().linkedMentionsPanelExpanded).toBe(true);
    expect(useTreeStore.getState().backlinksRailExpanded).toBe(true);
  });

  it("no-ops on Alt+T without Cmd/Ctrl (leaves tab-new shortcut untouched)", () => {
    handleAppPanelShortcuts(
      new KeyboardEvent("keydown", { key: "t", code: "KeyT", altKey: true }),
    );
    expect(useTreeStore.getState().tagsPanelExpanded).toBe(true);
  });
});

describe("handleAppCmdK (Phase 22 Plan 01 — unified palette)", () => {
  beforeEach(() => {
    useTreeStore.setState({ paletteOpen: false, paletteMode: "notes" });
  });

  it("Cmd+K opens the palette in unified 'all' mode and preventDefaults/stopPropagates", () => {
    const e = new KeyboardEvent("keydown", { key: "k", metaKey: true });
    const preventDefault = vi.spyOn(e, "preventDefault");
    const stopPropagation = vi.spyOn(e, "stopPropagation");
    handleAppCmdK(e);
    expect(useTreeStore.getState().paletteMode).toBe("all");
    expect(useTreeStore.getState().paletteOpen).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("Ctrl+K (non-Mac) also opens the palette in 'all' mode", () => {
    handleAppCmdK(new KeyboardEvent("keydown", { key: "K", ctrlKey: true }));
    expect(useTreeStore.getState().paletteMode).toBe("all");
    expect(useTreeStore.getState().paletteOpen).toBe(true);
  });

  it("no-ops without Cmd/Ctrl", () => {
    handleAppCmdK(new KeyboardEvent("keydown", { key: "k" }));
    expect(useTreeStore.getState().paletteOpen).toBe(false);
    expect(useTreeStore.getState().paletteMode).toBe("notes");
  });
});

describe("handleAppCmdDot (Phase 22 Plan 01 — zen toggle)", () => {
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

describe("Phase 25 Plan 08 — split-right/split-down/focus-cycle-pane shortcuts", () => {
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
