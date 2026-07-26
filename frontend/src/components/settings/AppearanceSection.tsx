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
import { useCallback, useEffect, useState } from "react";
import { Eyebrow, ControlRow } from "./shared";
import { SliderNumberPair } from "./SliderNumberPair";
import { TypePreviewPanel } from "./TypePreviewPanel";
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

  // Live values for the type preview: seeded from the persisted config, then
  // re-seeded whenever it changes underneath us (e.g. a pane Reset landing
  // from the shell), so the preview reflects a just-committed value while
  // `config` itself is still catching up to the in-flight save.
  const [fontSize, setFontSize] = useState(config.editor.fontSize);
  const [lineHeight, setLineHeight] = useState(config.editor.lineHeight);

  useEffect(() => {
    setFontSize(config.editor.fontSize);
  }, [config.editor.fontSize]);

  useEffect(() => {
    setLineHeight(config.editor.lineHeight);
  }, [config.editor.lineHeight]);

  // Stable identities: SliderNumberPair keeps the formatter out of its sync
  // effect's deps, but a memoized arrow also keeps the prop itself honest.
  const formatPx = useCallback((v: number) => `${v}px`, []);
  const formatUnitless = useCallback((v: number) => `${v}`, []);

  const commitFontSize = useCallback(
    async (value: number) => {
      setFontSize(value);
      const { error } = await saveConfig({
        ...config,
        editor: { ...config.editor, fontSize: value },
      });
      if (error) {
        setFontSize(config.editor.fontSize);
        onSaveError(`Couldn't save your changes: ${error.message}.`);
      } else {
        onSaveError(null);
      }
    },
    [config, saveConfig, onSaveError],
  );

  const commitLineHeight = useCallback(
    async (value: number) => {
      setLineHeight(value);
      const { error } = await saveConfig({
        ...config,
        editor: { ...config.editor, lineHeight: value },
      });
      if (error) {
        setLineHeight(config.editor.lineHeight);
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
      <div style={{ marginBottom: 16 }}>
        <ControlRow
          label="Accent color"
          description="Used for links, tags, highlights and selection"
        >
          <div style={{ display: "flex", gap: 8 }}>
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
        </ControlRow>
      </div>

      <Eyebrow text="TYPOGRAPHY" />

      <ControlRow label="Reading font" description="Typeface for note body text">
        <div role="group" aria-label="Reading font" style={{ display: "flex", gap: 4 }}>
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
      </ControlRow>

      <ControlRow
        label="Font size"
        htmlFor="settings-font-size"
        description="Body text size in the editor · 8–32px"
      >
        <SliderNumberPair
          id="settings-font-size"
          label="Font size"
          value={fontSize}
          sliderMin={12}
          sliderMax={24}
          numberMin={8}
          numberMax={32}
          step={1}
          unit="px"
          cssVar="--editor-font-size"
          formatCssValue={formatPx}
          onCommit={(v) => {
            void commitFontSize(v);
          }}
        />
      </ControlRow>

      <ControlRow
        label="Line height"
        htmlFor="settings-line-height"
        description="Vertical rhythm of paragraphs and lists · 1.0–3.0"
      >
        <SliderNumberPair
          id="settings-line-height"
          label="Line height"
          value={lineHeight}
          sliderMin={1.2}
          sliderMax={2.0}
          numberMin={1.0}
          numberMax={3.0}
          step={0.05}
          unit=""
          cssVar="--editor-line-height"
          formatCssValue={formatUnitless}
          onCommit={(v) => {
            void commitLineHeight(v);
          }}
        />
      </ControlRow>

      {/* SliderNumberPair writes --editor-font-size / --editor-line-height onto
          document.documentElement, so the real note editor behind this dialog
          restyles in step (D-26) — a whole-app restyle by design, not a
          scoping leak. */}
      <TypePreviewPanel fontSize={fontSize} lineHeight={lineHeight} />
    </section>
  );
}
