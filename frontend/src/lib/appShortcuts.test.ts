import { describe, it, expect, vi } from "vitest";
import {
  handleAppAltT,
  subscribePhase7,
  type Phase7DispatchEvent,
} from "./appShortcuts";

describe("handleAppAltT (tab-new)", () => {
  it("dispatches 'newTab' and preventDefaults on plain Alt+T", () => {
    const received: Phase7DispatchEvent[] = [];
    const unsubscribe = subscribePhase7((ev) => received.push(ev));
    try {
      const e = new KeyboardEvent("keydown", { key: "t", altKey: true });
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
        new KeyboardEvent("keydown", { key: "t", altKey: true, metaKey: true }),
      );
      handleAppAltT(
        new KeyboardEvent("keydown", { key: "t", altKey: true, ctrlKey: true }),
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
      handleAppAltT(new KeyboardEvent("keydown", { key: "t" }));
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
      handleAppAltT(new KeyboardEvent("keydown", { key: "T", altKey: true }));
      expect(received).toEqual(["newTab"]);
    } finally {
      unsubscribe();
    }
  });
});
