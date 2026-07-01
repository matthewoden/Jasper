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

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- param kept for call-site compat (dark-only, D-01); removed in a later phase
export function applyTheme(_theme?: string): void {
  document.documentElement.setAttribute("data-theme", "dark");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- param kept for call-site compat (dark-only, D-01); removed in a later phase
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

  // Impl ignores the arg (dark-only, D-01); the returned type keeps `(t: string)` so callers still typecheck.
  const setTheme = async () => {
    applyTheme();
    persistBootstrap();
    return {};
  };

  return { theme: "dark", setTheme };
}
