/**
 * useTheme — applies <html data-theme> from useConfig + persists user
 * toggles to config.json AND localStorage["jasper:theme-bootstrap"]
 * (so the next page load avoids the flash via /theme-bootstrap.js).
 *
 * D-15 First-run flow:
 *   1. /theme-bootstrap.js sets data-theme from prefers-color-scheme
 *      synchronously before React mounts.
 *   2. useTheme runs in useEffect after mount; reads useConfig().config.
 *   3. When config first arrives, useTheme overwrites data-theme with
 *      config.theme (the persisted user preference) ONLY IF the user
 *      has not already toggled manually.
 *   4. setTheme(t) called from SettingsMenu: writes data-theme + LS
 *      bootstrap cache + dispatches PUT /config.
 *
 * D-16: data-theme on <html> is the SOLE source of truth. CSS
 * variables retarget; CodeMirror's themeBridge reads the same
 * variables; one DOM mutation restyles the entire app.
 */
import { useCallback, useEffect, useRef } from "react";
import { useConfig } from "./useConfig";
import type { Config } from "./useConfig";

export const THEME_BOOTSTRAP_KEY = "jasper:theme-bootstrap";

export function getCurrentTheme(): "dark" | "light" {
  const v = document.documentElement.getAttribute("data-theme");
  return v === "light" ? "light" : "dark";
}

// Exported so the vault-picker create pane can flip <html data-theme>
// live as the user clicks the radio (no save round-trip; the picker
// reloads the SPA after submit, at which point useTheme reconciles
// with the persisted config).
export function applyTheme(theme: "dark" | "light"): void {
  document.documentElement.setAttribute("data-theme", theme);
}

function persistBootstrap(theme: "dark" | "light"): void {
  try {
    localStorage.setItem(THEME_BOOTSTRAP_KEY, theme);
  } catch {
    /* private mode — fall through, next reload uses prefers-color-scheme */
  }
}

export function useTheme(): {
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => Promise<{ error?: { message: string } }>;
} {
  const { config, saveConfig } = useConfig();
  // Track whether the user has manually toggled. After a toggle, we
  // suppress the config-driven effect so the DOM is not reverted.
  const userToggledRef = useRef(false);

  // When config first arrives (and user has not manually toggled yet),
  // overwrite data-theme with the persisted value (the bootstrap script
  // may have set it from prefers-color-scheme before the real value was known).
  useEffect(() => {
    if (!config || userToggledRef.current) return;
    const next: "dark" | "light" = config.theme === "light" ? "light" : "dark";
    applyTheme(next);
    persistBootstrap(next);
  }, [config]);

  const setTheme = useCallback(
    async (t: "dark" | "light") => {
      // Mark user toggle so the config effect no longer overwrites data-theme.
      userToggledRef.current = true;
      // Capture current theme before optimistic apply so we can roll back.
      const prevTheme = getCurrentTheme();
      // Optimistic: flip data-theme + LS bootstrap immediately so the
      // user sees the change without round-trip latency.
      applyTheme(t);
      persistBootstrap(t);
      if (!config) {
        // No config loaded yet — schedule the persist for after load.
        // Acceptable v1 behavior; the bootstrap LS cache covers reload.
        return {};
      }
      const next: Config = { ...config, theme: t };
      const { error } = await saveConfig(next);
      if (error) {
        // Full rollback: revert DOM and LS cache so the UI matches
        // persisted state (avoids confusing mismatch between visual
        // theme and Settings menu check-mark on PUT failure).
        applyTheme(prevTheme);
        try {
          localStorage.removeItem(THEME_BOOTSTRAP_KEY);
        } catch {
          /* ignore */
        }
        return { error: { message: error.message } };
      }
      return {};
    },
    [config, saveConfig],
  );

  return { theme: getCurrentTheme(), setTheme };
}
