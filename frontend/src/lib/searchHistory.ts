/**
 * searchHistory — vault-namespaced localStorage MRU search-history store
 * (HIST-01/02, D-16/D-17/D-18). Powers SearchHistoryHints.
 *
 * Recorded ONLY on committed searches (Enter-open or result-row click) —
 * NEVER from SidebarSearchPanel's debounced fetch effect (D-16). Capacity
 * 10, MRU order (most-recent first), case-insensitive dedupe on the exact
 * query string (D-18): re-running an existing query moves it to the top.
 *
 * Namespacing follows usePaneStore.ts's layoutKeyForVault precedent
 * (`jasper.layout.${encodeURIComponent(vaultPath)}`), NOT the stale
 * `jasper:tabs:<base64(vaultPath)>` key CONTEXT.md/UI-SPEC cite — that key
 * does not exist anywhere in the codebase (RESEARCH Pattern 7 correction).
 *
 * Plain module-level array + subscriber set (not a zustand store) — only
 * SearchHistoryHints and SidebarSearchPanel consume it, and a small pub/sub
 * is simpler than standing up a new store for a single array. Corruption
 * tolerance mirrors useTreeStore.ts's LS_KEY_SWITCHER_RECENCY shape
 * (try/catch + Array.isArray + filter(isString) + slice(0, CAPACITY)):
 * a bad/missing localStorage value never throws, it just yields [].
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
 * recordSearchHistory — commit-point write (D-16). Trims the query, ignores
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

/** removeHistoryEntry — per-row removal (D-21). Removes exactly one entry. */
export function removeHistoryEntry(query: string): void {
  const next = history.filter((q) => q !== query);
  if (next.length === history.length) return;
  history = next;
  persist();
  notify();
}

/**
 * filterSearchHistory — shared prefix-match filter (D-19), used by both
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
