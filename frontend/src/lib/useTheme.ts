/**
 * useTheme — dark-only theme hook (Phase 17 D-01).
 *
 * Applies data-theme="dark" unconditionally. The light branch and setTheme
 * toggle are removed; applyTheme and persistBootstrap remain exported so
 * any call sites (SettingsDialog, SetupApp) don't break until Wave 3
 * removes them.
 *
 * data-theme on <html> is the sole source of truth — CSS variables retarget
 * from it and CodeMirror's themeBridge reads the same variables, so one DOM
 * mutation restyles the entire app.
 */
import { useEffect } from "react";
import { useConfig } from "./useConfig";

export const THEME_BOOTSTRAP_KEY = "jasper:theme-bootstrap";

export function applyTheme(_theme?: string): void {
  document.documentElement.setAttribute("data-theme", "dark");
}

export function persistBootstrap(_theme?: string): void {
  try {
    localStorage.setItem(THEME_BOOTSTRAP_KEY, "dark");
  } catch {
    /* private mode — fall through */
  }
}

export function useTheme(): {
  theme: "dark";
  setTheme: (t: string) => Promise<{ error?: { message: string } }>;
} {
  const { config } = useConfig();

  useEffect(() => {
    if (!config) return;
    applyTheme();
    persistBootstrap();
  }, [config]);

  const setTheme = async (_t: string) => {
    applyTheme();
    persistBootstrap();
    return {};
  };

  return { theme: "dark", setTheme };
}
