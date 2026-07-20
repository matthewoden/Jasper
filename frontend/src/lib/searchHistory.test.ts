import { describe, it, expect, beforeEach } from "vitest";
import {
  historyKeyForVault,
  initForVault,
  getHistory,
  recordSearchHistory,
  removeHistoryEntry,
  filterSearchHistory,
} from "./searchHistory";

beforeEach(() => {
  window.localStorage.clear();
});

describe("searchHistory", () => {
  it("uses the jasper.search-history.<encoded vault> key format (no base64/btoa)", () => {
    expect(historyKeyForVault("/Users/me/my vault")).toBe(
      `jasper.search-history.${encodeURIComponent("/Users/me/my vault")}`,
    );
    expect(historyKeyForVault("/Users/me/my vault")).not.toContain("jasper:tabs:");
  });

  it("dedupes case-insensitively and moves the entry to the MRU top", () => {
    initForVault("/vault/dedupe");
    recordSearchHistory("meet");
    recordSearchHistory("Meet");
    expect(getHistory()).toEqual(["Meet"]);
  });

  it("keeps only the 10 most recent of 11 distinct queries", () => {
    initForVault("/vault/capacity");
    for (let i = 0; i < 11; i++) {
      recordSearchHistory(`query-${i}`);
    }
    const h = getHistory();
    expect(h.length).toBe(10);
    expect(h[0]).toBe("query-10");
    expect(h).not.toContain("query-0");
  });

  it("getHistory returns entries most-recent-first", () => {
    initForVault("/vault/order");
    recordSearchHistory("first");
    recordSearchHistory("second");
    recordSearchHistory("third");
    expect(getHistory()).toEqual(["third", "second", "first"]);
  });

  it("re-running an existing query moves it to the top without duplicating", () => {
    initForVault("/vault/rerun");
    recordSearchHistory("alpha");
    recordSearchHistory("beta");
    recordSearchHistory("alpha");
    expect(getHistory()).toEqual(["alpha", "beta"]);
  });

  it("ignores empty/whitespace-only queries", () => {
    initForVault("/vault/empty");
    recordSearchHistory("   ");
    recordSearchHistory("");
    expect(getHistory()).toEqual([]);
  });

  it("yields [] when localStorage has no entry for this vault", () => {
    initForVault("/vault/missing");
    expect(getHistory()).toEqual([]);
  });

  it("yields [] on corrupt localStorage JSON without throwing", () => {
    const key = historyKeyForVault("/vault/corrupt");
    window.localStorage.setItem(key, "{not valid json");
    expect(() => initForVault("/vault/corrupt")).not.toThrow();
    expect(getHistory()).toEqual([]);
  });

  it("yields [] when the stored value is not an array", () => {
    const key = historyKeyForVault("/vault/wrong-shape");
    window.localStorage.setItem(key, JSON.stringify({ not: "an array" }));
    initForVault("/vault/wrong-shape");
    expect(getHistory()).toEqual([]);
  });

  it("removeHistoryEntry removes exactly one entry", () => {
    initForVault("/vault/remove");
    recordSearchHistory("alpha");
    recordSearchHistory("beta");
    recordSearchHistory("gamma");
    removeHistoryEntry("beta");
    expect(getHistory()).toEqual(["gamma", "alpha"]);
  });

  it("removeHistoryEntry is a no-op for an entry that isn't present", () => {
    initForVault("/vault/remove-noop");
    recordSearchHistory("alpha");
    removeHistoryEntry("does-not-exist");
    expect(getHistory()).toEqual(["alpha"]);
  });

  it("initForVault(vaultA) then initForVault(vaultB) reads distinct namespaced keys — no bleed", () => {
    initForVault("/vault/a");
    recordSearchHistory("only-in-a");

    initForVault("/vault/b");
    expect(getHistory()).toEqual([]);
    recordSearchHistory("only-in-b");
    expect(getHistory()).toEqual(["only-in-b"]);

    initForVault("/vault/a");
    expect(getHistory()).toEqual(["only-in-a"]);
  });

  it("persists across a fresh initForVault call for the same vault (durable, D-17)", () => {
    initForVault("/vault/durable");
    recordSearchHistory("survives-reload");

    initForVault("/vault/durable");
    expect(getHistory()).toEqual(["survives-reload"]);
  });

  it("filterSearchHistory prefix-matches case-insensitively and caps at 10", () => {
    const entries = ["Meeting notes", "weekly sync", "meet the team"];
    expect(filterSearchHistory(entries, "meet")).toEqual(["Meeting notes", "meet the team"]);
    expect(filterSearchHistory(entries, "")).toEqual(entries);
    expect(filterSearchHistory(entries, "zzz")).toEqual([]);
  });
});
