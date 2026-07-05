import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleAppAltT,
  handleAppCmdShiftF,
  handleAppPanelShortcuts,
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
      altKey: true,
      metaKey: true,
    });
    const preventDefault = vi.spyOn(e, "preventDefault");
    handleAppPanelShortcuts(e);
    expect(useTreeStore.getState().tagsPanelExpanded).toBe(true);
    expect(useTreeStore.getState().backlinksRailExpanded).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("Cmd+Alt+T collapsing the section does NOT force the rail open", () => {
    useTreeStore.setState({ tagsPanelExpanded: true, backlinksRailExpanded: true });
    handleAppPanelShortcuts(
      new KeyboardEvent("keydown", { key: "t", altKey: true, metaKey: true }),
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
      new KeyboardEvent("keydown", { key: "b", altKey: true, metaKey: true }),
    );
    expect(useTreeStore.getState().linkedMentionsPanelExpanded).toBe(true);
    expect(useTreeStore.getState().backlinksRailExpanded).toBe(true);
  });

  it("no-ops on Alt+T without Cmd/Ctrl (leaves tab-new shortcut untouched)", () => {
    handleAppPanelShortcuts(
      new KeyboardEvent("keydown", { key: "t", altKey: true }),
    );
    expect(useTreeStore.getState().tagsPanelExpanded).toBe(true);
  });
});
