/**
 * ThemeSection — Appearance step for the first-run wizard.
 *
 * Dark-only: no theme toggle offered. Shows the accent swatch picker
 * and the reading-font toggle (Sans / Serif). Live preview applies on each
 * selection so the wizard restyles as the user picks.
 *
 * aria-label values on swatch buttons match the Copywriting Contract ("Purple",
 * "Sky", "Green", "Orange") — Playwright selectors in phase17-uat.spec.ts
 * depend on these exact strings.
 */

import { applyAccent, applyReadingFont } from "../../lib/useAccent";

interface ThemeSectionProps {
  accent: string;
  readingFont: "sans" | "serif";
  onAccentChange: (a: string) => void;
  onReadingFontChange: (rf: "sans" | "serif") => void;
}

const ACCENT_SWATCHES = [
  { key: "purple", hex: "#a78bfa", label: "Purple" },
  { key: "sky",    hex: "#7dd3fc", label: "Sky" },
  { key: "green",  hex: "#34d399", label: "Green" },
  { key: "orange", hex: "#fb923c", label: "Orange" },
] as const;

export function ThemeSection({
  accent,
  readingFont,
  onAccentChange,
  onReadingFontChange,
}: ThemeSectionProps) {
  const selectAccent = (key: string) => {
    applyAccent(key);
    onAccentChange(key);
  };

  const selectReadingFont = (rf: "sans" | "serif") => {
    applyReadingFont(rf);
    onReadingFontChange(rf);
  };

  return (
    <section style={{ marginBottom: 24 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--color-muted)",
          letterSpacing: 0.4,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        APPEARANCE
      </div>

      {/* Accent color */}
      <div style={{ marginBottom: 16 }}>
        <p
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--color-fg)",
            margin: "0 0 8px",
          }}
        >
          Choose your accent color
        </p>
        <div
          role="group"
          aria-label="Accent color"
          style={{ display: "flex", gap: 8 }}
        >
          {ACCENT_SWATCHES.map(({ key, hex, label }) => {
            const selected = accent === key;
            return (
              <button
                key={key}
                type="button"
                aria-label={label}
                aria-pressed={selected}
                onClick={() => selectAccent(key)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: hex,
                  border: selected
                    ? "2px solid var(--color-fg)"
                    : "2px solid transparent",
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
      </div>

      {/* Reading font */}
      <div>
        <p
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--color-fg)",
            margin: "0 0 2px",
          }}
        >
          Reading font
        </p>
        <p
          style={{
            fontSize: 12,
            color: "var(--color-muted)",
            margin: "0 0 8px",
          }}
        >
          Applies to note content only
        </p>
        <div
          role="group"
          aria-label="Reading font"
          style={{ display: "flex", gap: 4 }}
        >
          {(["sans", "serif"] as const).map((rf) => {
            const active = readingFont === rf;
            return (
              <button
                key={rf}
                type="button"
                aria-pressed={active}
                onClick={() => selectReadingFont(rf)}
                style={{
                  padding: "4px 12px",
                  borderRadius: 4,
                  border: "none",
                  background: active
                    ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                    : "transparent",
                  color: active ? "var(--color-fg)" : "var(--color-muted)",
                  fontWeight: active ? 600 : 400,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {rf === "sans" ? "Sans" : "Serif"}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
