/**
 * searchHistory — a vault-namespaced MRU of committed searches (HIST-01/02).
 *
 * Recorded ONLY on a commit (Enter or a result click), never from the debounced
 * fetch effect. Capacity 10, case-insensitive dedupe.
 *
 * A plain module array plus a subscriber set, not a store: two consumers do not
 * justify one. A corrupt localStorage value yields [] rather than throwing.
 */
import { useSyncExternalStore } from "react";

export const historyKeyForVault = (vaultPath: string): string =>
  `jasper.search-history.${encodeURIComponent(vaultPath)}`;

const CAPACITY = 10;

let history: string[] = [];
let activeVaultKey: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  if (activeVaultKey === null) return;
  try {
    window.localStorage.setItem(activeVaultKey, JSON.stringify(history));
  } catch {
    // Ignore quota / private-mode failures — persistence is best-effort.
  }
}

/**
 * initForVault — hydrate this vault's history from localStorage into module
 * state. Called from the same vaultPath-gated App.tsx effect that calls
 * usePaneStore.initForVault. Never throws: corrupt/missing storage yields [].
 */
export function initForVault(vaultPath: string): void {
  const key = historyKeyForVault(vaultPath);
  activeVaultKey = key;

  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      history = [];
    } else {
      const parsed: unknown = JSON.parse(raw);
      history = Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === "string").slice(0, CAPACITY)
        : [];
    }
  } catch {
    history = [];
  }

  notify();
}

/** getHistory — the current vault's history, most-recent-first. */
export function getHistory(): string[] {
  return history;
}

/**
 * recordSearchHistory — commit-point write. Trims the query, ignores
 * empty strings, dedupes case-insensitively (removing any existing
 * case-variant), unshifts to the front (MRU), and caps at CAPACITY.
 */
export function recordSearchHistory(query: string): void {
  const trimmed = query.trim();
  if (trimmed === "") return;
  const lower = trimmed.toLowerCase();
  const deduped = history.filter((q) => q.toLowerCase() !== lower);
  history = [trimmed, ...deduped].slice(0, CAPACITY);
  persist();
  notify();
}

/** removeHistoryEntry — per-row removal. Removes exactly one entry. */
export function removeHistoryEntry(query: string): void {
  const next = history.filter((q) => q !== query);
  if (next.length === history.length) return;
  history = next;
  persist();
  notify();
}

/**
 * filterSearchHistory — shared prefix-match filter, used by both
 * SearchHistoryHints (rendering) and SidebarSearchPanel (keyboard routing)
 * so the two never drift out of sync on what counts as a "match".
 */
export function filterSearchHistory(entries: string[], query: string): string[] {
  const lower = query.trim().toLowerCase();
  return entries.filter((q) => q.toLowerCase().startsWith(lower)).slice(0, CAPACITY);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** useSearchHistory — React hook giving components a live, re-render-on-change view of getHistory(). */
export function useSearchHistory(): string[] {
  return useSyncExternalStore(subscribe, getHistory, getHistory);
}
