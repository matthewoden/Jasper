/**
 * data-theme on <html> is the sole source of truth — CSS variables retarget from it
 * and CodeMirror's themeBridge reads the same variables, so one DOM mutation
 * restyles the entire app.
 */
import { useEffect } from "react";

export const THEME_BOOTSTRAP_KEY = "jasper:theme-bootstrap";

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- param kept for call-site compat (dark-only)
export function applyTheme(_theme?: string): void {
  document.documentElement.setAttribute("data-theme", "dark");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- param kept for call-site compat (dark-only)
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
  // Dark is config-independent, so apply once on mount instead of
  // re-running on every config change. applyTheme/persistBootstrap set
  // data-theme="dark" unconditionally.
  useEffect(() => {
    applyTheme();
    persistBootstrap();
  }, []);

  // Impl ignores the arg (dark-only); the returned type keeps `(t: string)` so callers still typecheck.
  const setTheme = async () => {
    applyTheme();
    persistBootstrap();
    return {};
  };

  return { theme: "dark", setTheme };
}
