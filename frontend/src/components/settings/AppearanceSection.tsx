/**
 * AppearanceSection — the Appearance pane (SET3-07). Settings always opens
 * here (D-20); the accent-swatch row is this phase's primary visual anchor.
 *
 * Accent and reading font route through useAccent.ts's non-hook helpers
 * (applyAccent/persistAccentBootstrap/applyReadingFont/persistReadingFontBootstrap)
 * plus a single saveConfig call — never the config-mounting hook itself,
 * which would create a second independent config state and make D-10's
 * single-write pane Reset silently partial.
 */
import { useCallback } from "react";
import { Eyebrow } from "./shared";
import {
  applyAccent,
  persistAccentBootstrap,
  applyReadingFont,
  persistReadingFontBootstrap,
} from "../../lib/useAccent";
import type { Config } from "../../lib/useConfig";
import type { SectionProps } from "./types";

const ACCENT_SWATCHES = [
  { id: "purple", label: "Purple", hex: "#a78bfa" },
  { id: "sky", label: "Sky", hex: "#7dd3fc" },
  { id: "green", label: "Green", hex: "#34d399" },
  { id: "orange", label: "Orange", hex: "#fb923c" },
] as const satisfies readonly { id: Config["accent"]; label: string; hex: string }[];

export function AppearanceSection({ config, saveConfig, onSaveError }: SectionProps) {
  const handleAccentChange = useCallback(
    async (id: Config["accent"]) => {
      const prev = config.accent;
      applyAccent(id);
      persistAccentBootstrap(id);
      const { error } = await saveConfig({ ...config, accent: id });
      if (error) {
        applyAccent(prev);
        persistAccentBootstrap(prev); // WR-01: revert the bootstrap key, else next reload flashes the rejected accent
        onSaveError(`Couldn't save your changes: ${error.message}.`);
      } else {
        onSaveError(null);
      }
    },
    [config, saveConfig, onSaveError],
  );

  const handleReadingFontChange = useCallback(
    async (rf: Config["readingFont"]) => {
      const prev = config.readingFont;
      applyReadingFont(rf);
      persistReadingFontBootstrap(rf);
      const { error } = await saveConfig({ ...config, readingFont: rf });
      if (error) {
        applyReadingFont(prev);
        persistReadingFontBootstrap(prev); // WR-01: revert the bootstrap key, else next reload flashes the rejected font
        onSaveError(`Couldn't save your changes: ${error.message}.`);
      } else {
        onSaveError(null);
      }
    },
    [config, saveConfig, onSaveError],
  );

  return (
    <section>
      <Eyebrow text="COLOR" />
      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        {ACCENT_SWATCHES.map(({ id, label, hex }) => {
          const selected = config.accent === id;
          return (
            <button
              key={id}
              type="button"
              aria-label={label}
              aria-pressed={selected}
              onClick={() => {
                void handleAccentChange(id);
              }}
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: hex,
                border: selected ? "2px solid var(--color-fg)" : "2px solid transparent",
                outline: selected ? `2px solid ${hex}` : "none",
                outlineOffset: 2,
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
              }}
            />
          );
        })}
      </div>

      <Eyebrow text="TYPOGRAPHY" />

      <div style={{ marginBottom: 16 }}>
        <div role="group" aria-label="Reading font" style={{ display: "flex", gap: 4, marginBottom: 4 }}>
          {(["sans", "serif"] as const).map((rf) => {
            const active = config.readingFont === rf;
            return (
              <button
                key={rf}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  void handleReadingFontChange(rf);
                }}
                style={{
                  padding: "4px 14px",
                  borderRadius: 16,
                  border: "1px solid var(--color-border)",
                  background: active
                    ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                    : "transparent",
                  color: active ? "var(--color-fg)" : "var(--color-muted)",
                  fontWeight: active ? 600 : 400,
                  fontSize: 13,
                  fontFamily: "inherit",
                  cursor: "pointer",
                }}
              >
                {rf === "sans" ? "Sans" : "Serif"}
              </button>
            );
          })}
        </div>
        <span style={{ fontSize: 12, color: "var(--color-muted)" }}>Applies to note content only</span>
      </div>
    </section>
  );
}
