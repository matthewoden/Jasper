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
  const userToggledRef = useRef(false);

  useEffect(() => {
    if (!config || userToggledRef.current) return;
    const next: "dark" | "light" = config.theme === "light" ? "light" : "dark";
    applyTheme(next);
    persistBootstrap(next);
  }, [config]);

  const setTheme = useCallback(
    async (t: "dark" | "light") => {
      userToggledRef.current = true;
      const prevTheme = getCurrentTheme();
      applyTheme(t);
      persistBootstrap(t);
      if (!config) {
        return {};
      }
      const next: Config = { ...config, theme: t };
      const { error } = await saveConfig(next);
      if (error) {
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
