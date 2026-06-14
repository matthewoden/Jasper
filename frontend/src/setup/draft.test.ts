/**
 * Tests for draft.ts — localStorage helpers for the first-run wizard.
 *
 * Coverage:
 *   - SETUP_DRAFT_KEY is locked at "jasper.setup.draft"
 *   - loadDraft returns DEFAULT_DRAFT when no key is present or JSON is malformed
 *   - saveDraft merges partial patches into existing state
 *   - clearDraft removes the key
 *   - Older drafts missing newer fields load with defaults (forward-compat)
 *   - Private-mode safety: when localStorage throws, save/load/clear swallow it
 */
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  SETUP_DRAFT_KEY,
  DEFAULT_DRAFT,
  loadDraft,
  saveDraft,
  clearDraft,
  type SetupDraft,
} from "./draft";

beforeEach(() => {
  localStorage.clear();
});

describe("SETUP_DRAFT_KEY", () => {
  it("is locked to 'jasper.setup.draft'", () => {
    expect(SETUP_DRAFT_KEY).toBe("jasper.setup.draft");
  });
});

describe("loadDraft", () => {
  it("returns DEFAULT_DRAFT when localStorage is empty", () => {
    const result = loadDraft();
    expect(result).toEqual(DEFAULT_DRAFT);
    result.dataDir = "x";
    expect(DEFAULT_DRAFT.dataDir).toBe("");
  });

  it("returns DEFAULT_DRAFT when stored JSON is malformed", () => {
    localStorage.setItem(SETUP_DRAFT_KEY, "{not-json");
    expect(loadDraft()).toEqual(DEFAULT_DRAFT);
  });

  it("returns DEFAULT_DRAFT when stored JSON parses to null", () => {
    localStorage.setItem(SETUP_DRAFT_KEY, "null");
    expect(loadDraft()).toEqual(DEFAULT_DRAFT);
  });

  it("returns the persisted draft when present", () => {
    const persisted: SetupDraft = {
      dataDir: "~/Notes",
      theme: "light",
      mcpEnabled: true,
      mcpGrants: [{ folder: "projects", level: 1 }],
      dailyTemplate: "# CUSTOM\n",
      createTodayDailyNote: true,
    };
    localStorage.setItem(SETUP_DRAFT_KEY, JSON.stringify(persisted));
    expect(loadDraft()).toEqual(persisted);
  });

  it("shallow-merges older drafts missing newer fields with DEFAULT_DRAFT", () => {
    localStorage.setItem(
      SETUP_DRAFT_KEY,
      JSON.stringify({ dataDir: "~/X", theme: "light" }),
    );
    const out = loadDraft();
    expect(out.dataDir).toBe("~/X");
    expect(out.theme).toBe("light");
    expect(out.mcpEnabled).toBe(DEFAULT_DRAFT.mcpEnabled);
    expect(out.mcpGrants).toEqual(DEFAULT_DRAFT.mcpGrants);
    expect(out.dailyTemplate).toBe(DEFAULT_DRAFT.dailyTemplate);
    expect(out.createTodayDailyNote).toBe(DEFAULT_DRAFT.createTodayDailyNote);
  });
});

describe("saveDraft", () => {
  it("writes a full draft when none exists", () => {
    saveDraft({ dataDir: "~/Notes" });
    const stored = JSON.parse(localStorage.getItem(SETUP_DRAFT_KEY)!);
    expect(stored.dataDir).toBe("~/Notes");
    expect(stored.theme).toBe(DEFAULT_DRAFT.theme);
    expect(stored.mcpEnabled).toBe(DEFAULT_DRAFT.mcpEnabled);
  });

  it("merges patches into the existing draft", () => {
    saveDraft({ dataDir: "~/Notes", theme: "light" });
    saveDraft({ mcpEnabled: true });
    const out = loadDraft();
    expect(out.dataDir).toBe("~/Notes");
    expect(out.theme).toBe("light");
    expect(out.mcpEnabled).toBe(true);
  });
});

describe("clearDraft", () => {
  it("removes the persisted draft", () => {
    saveDraft({ dataDir: "~/Notes" });
    expect(localStorage.getItem(SETUP_DRAFT_KEY)).not.toBeNull();
    clearDraft();
    expect(localStorage.getItem(SETUP_DRAFT_KEY)).toBeNull();
    expect(loadDraft()).toEqual(DEFAULT_DRAFT);
  });

  it("is a no-op when no draft is stored", () => {
    expect(() => clearDraft()).not.toThrow();
    expect(localStorage.getItem(SETUP_DRAFT_KEY)).toBeNull();
  });
});

describe("private-mode safety", () => {
  let originalGet: typeof Storage.prototype.getItem;
  let originalSet: typeof Storage.prototype.setItem;
  let originalRemove: typeof Storage.prototype.removeItem;

  beforeEach(() => {
    originalGet = Storage.prototype.getItem;
    originalSet = Storage.prototype.setItem;
    originalRemove = Storage.prototype.removeItem;
  });

  afterEach(() => {
    Storage.prototype.getItem = originalGet;
    Storage.prototype.setItem = originalSet;
    Storage.prototype.removeItem = originalRemove;
  });

  it("loadDraft returns DEFAULT_DRAFT when getItem throws", () => {
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error("private mode");
    });
    expect(loadDraft()).toEqual(DEFAULT_DRAFT);
  });

  it("saveDraft swallows setItem exceptions", () => {
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error("private mode");
    });
    expect(() => saveDraft({ dataDir: "~/X" })).not.toThrow();
  });

  it("clearDraft swallows removeItem exceptions", () => {
    Storage.prototype.removeItem = vi.fn(() => {
      throw new Error("private mode");
    });
    expect(() => clearDraft()).not.toThrow();
  });
});
