/**
 * useAccent — syncs --color-accent and --font-reading CSS vars from
 * useConfig, persists user selections to config.json AND localStorage
 * (so the next page load avoids flash via /theme-bootstrap.js).
 *
 * applyAccent/applyReadingFont are exported so theme-bootstrap.js and
 * SettingsDialog can call them without going through the hook.
 *
 * Pattern mirrors useTheme.ts: optimistic apply → saveConfig → rollback
 * on failure. localStorage bootstrap keys are updated in parallel so
 * the next reload restores the correct value before React mounts.
 */
import { useCallback, useEffect } from "react";
import { useConfig } from "./useConfig";
import type { Config } from "./useConfig";

export const ACCENT_BOOTSTRAP_KEY = "jasper:accent-bootstrap";
export const READING_FONT_KEY = "jasper:reading-font-bootstrap";

const ACCENT_COLORS: Record<string, string> = {
  purple: "#a78bfa",
  sky: "#7dd3fc",
  green: "#34d399",
  orange: "#fb923c",
};

const SERIF_STACK = "'Source Serif 4', Georgia, 'Times New Roman', serif";

export function applyAccent(accent: string): void {
  const hex = ACCENT_COLORS[accent] ?? "#a78bfa";
  document.documentElement.style.setProperty("--color-accent", hex);
}

export function persistAccentBootstrap(accent: string): void {
  try {
    localStorage.setItem(ACCENT_BOOTSTRAP_KEY, accent);
  } catch {
    /* private mode — fall through */
  }
}

export function applyReadingFont(rf: string): void {
  if (rf === "serif") {
    document.documentElement.style.setProperty("--font-reading", SERIF_STACK);
  } else {
    document.documentElement.style.removeProperty("--font-reading");
  }
}

export function persistReadingFontBootstrap(rf: string): void {
  try {
    localStorage.setItem(READING_FONT_KEY, rf);
  } catch {
    /* private mode — fall through */
  }
}

export function useAccent(): {
  accent: string;
  setAccent: (a: string) => Promise<{ error?: { message: string } }>;
  readingFont: string;
  setReadingFont: (rf: string) => Promise<{ error?: { message: string } }>;
} {
  const { config, saveConfig } = useConfig();

  useEffect(() => {
    if (!config) return;
    applyAccent(config.accent ?? "purple");
    persistAccentBootstrap(config.accent ?? "purple");
  }, [config?.accent]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!config) return;
    applyReadingFont(config.readingFont ?? "sans");
    persistReadingFontBootstrap(config.readingFont ?? "sans");
  }, [config?.readingFont]); // eslint-disable-line react-hooks/exhaustive-deps

  const setAccent = useCallback(
    async (a: string) => {
      if (!config) return {};
      const prev = config.accent ?? "purple";
      applyAccent(a);
      persistAccentBootstrap(a);
      const { error } = await saveConfig({ accent: a as Config["accent"] });
      if (error) {
        applyAccent(prev);
        persistAccentBootstrap(prev); // WR-01: revert the bootstrap key too, else next reload flashes the rejected accent
        return { error: { message: error.message } };
      }
      return {};
    },
    [config, saveConfig],
  );

  const setReadingFont = useCallback(
    async (rf: string) => {
      if (!config) return {};
      const prev = config.readingFont ?? "sans";
      applyReadingFont(rf);
      persistReadingFontBootstrap(rf);
      const { error } = await saveConfig({ readingFont: rf as Config["readingFont"] });
      if (error) {
        applyReadingFont(prev);
        persistReadingFontBootstrap(prev); // WR-01: revert the bootstrap key too, else next reload flashes the rejected font
        return { error: { message: error.message } };
      }
      return {};
    },
    [config, saveConfig],
  );

  return {
    accent: config?.accent ?? "purple",
    setAccent,
    readingFont: config?.readingFont ?? "sans",
    setReadingFont,
  };
}
