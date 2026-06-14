/**
 * SettingsDialog — in-app settings panel (Radix Dialog modal).
 *
 * Four sections (APPEARANCE / EDITOR / DAILY NOTES / GENERAL), auto-persist
 * on blur/Enter (no Save button), live CSS-var apply for font/line height,
 * restart badges for vim mode and autosaveMs.
 *
 * CRITICAL: Vim copy is HONEST — "not yet active — they will be enabled in a
 * future update." The preference is saved; key bindings are not yet wired.
 */
import * as Dialog from "@radix-ui/react-dialog";
import * as Switch from "@radix-ui/react-switch";
import { AlertCircle } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { useConfig } from "../lib/useConfig";
import { applyTheme } from "../lib/useTheme";

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

// ─── Restart badge ─────────────────────────────────────────────────────────
// aria-label ensures screen readers announce it (not color only).
function RestartBadge() {
  return (
    <span
      aria-label="Requires reload to apply"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 8px",
        height: 20,
        borderRadius: 10,
        fontSize: 12,
        fontWeight: 600,
        color: "var(--color-warning)",
        background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)",
        whiteSpace: "nowrap",
        boxSizing: "border-box",
      }}
    >
      <AlertCircle size={12} aria-hidden="true" />
      Reload to apply
    </span>
  );
}

// ─── Shared input style ────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  background: "var(--color-bg)",
  color: "var(--color-fg)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
};

// ─── Section divider ───────────────────────────────────────────────────────
function SectionDivider() {
  return (
    <hr
      style={{
        border: "none",
        borderTop: "1px solid var(--color-border)",
        margin: "24px 0",
      }}
    />
  );
}

// ─── Section eyebrow ──────────────────────────────────────────────────────
function Eyebrow({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: "var(--color-muted)",
        letterSpacing: 0.4,
        textTransform: "uppercase",
        marginBottom: 8,
      }}
    >
      {text}
    </div>
  );
}

// ─── Control label row ────────────────────────────────────────────────────
function ControlRow({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 16,
        marginBottom: 8,
      }}
    >
      <label
        htmlFor={htmlFor}
        style={{
          fontSize: 14,
          color: "var(--color-fg)",
          minWidth: 160,
          paddingTop: 8,
          flexShrink: 0,
        }}
      >
        {label}
      </label>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

// ─── Theme radio row (reuse ThemeSection pattern) ─────────────────────────
function ThemeRadioRow({
  label,
  value,
  selected,
  onSelect,
}: {
  label: string;
  value: "dark" | "light";
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        height: 36,
        gap: 10,
        cursor: "pointer",
        fontSize: 14,
        color: "var(--color-fg)",
        position: "relative",
      }}
    >
      <input
        type="radio"
        name="settings-theme"
        value={value}
        checked={selected}
        onChange={onSelect}
        aria-label={label}
        style={{
          appearance: "none",
          margin: 0,
          width: 16,
          height: 16,
          borderRadius: "50%",
          border: `1px solid ${selected ? "var(--color-accent)" : "var(--color-border)"}`,
          background: "var(--color-bg)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          cursor: "pointer",
          flexShrink: 0,
        }}
      />
      {selected && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "var(--color-accent)",
            marginLeft: 4,
            left: 0,
            pointerEvents: "none",
          }}
        />
      )}
      <span>{label}</span>
    </label>
  );
}

// ─── Main component ────────────────────────────────────────────────────────
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { config, saveConfig } = useConfig();

  // ── Local input state (controlled inputs that commit on blur/Enter) ──
  const [fontSizeInput, setFontSizeInput] = useState("");
  const [fontSizeError, setFontSizeError] = useState<string | null>(null);
  const [lineHeightInput, setLineHeightInput] = useState("");
  const [lineHeightError, setLineHeightError] = useState<string | null>(null);
  const [autosaveMsInput, setAutosaveMsInput] = useState("");
  const [autosaveMsError, setAutosaveMsError] = useState<string | null>(null);
  const [dailyFolder, setDailyFolder] = useState("");
  const [dailyTemplate, setDailyTemplate] = useState("");
  const [displayName, setDisplayName] = useState("");

  // ── Save error banner: shown when PUT /config fails ──
  // Cleared on any subsequent successful save or when dismissed.
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Seed local state when config loads ──────────────────────────────
  useEffect(() => {
    if (!config) return;
    setFontSizeInput(String(config.editor.fontSize));
    setLineHeightInput(String(config.editor.lineHeight));
    setAutosaveMsInput(String(config.editor.autosaveMs));
    setDailyFolder(config.dailyNotes.folder);
    setDailyTemplate(config.dailyNotes.template);
    setDisplayName(config.display_name ?? "");
  }, [config]);

  // ── Boot seeding: keep CSS vars in sync with persisted config ───────
  // Runs on mount even when the panel has never been opened — SettingsDialog
  // is always mounted (via SettingsMenu in StatusBar) so the editor reflects
  // persisted values without requiring the user to open settings first.
  useEffect(() => {
    if (!config) return;
    document.documentElement.style.setProperty(
      "--editor-font-size",
      `${config.editor.fontSize}px`,
    );
    document.documentElement.style.setProperty(
      "--editor-line-height",
      `${config.editor.lineHeight}`,
    );
  }, [config?.editor.fontSize, config?.editor.lineHeight]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Commit helpers ───────────────────────────────────────────────────
  // All handlers await saveConfig and surface errors in the save-error banner.
  // On failure, useConfig.saveConfig rolls back to the last persisted value
  // so the local input reverts in the next config sync.

  const handleFontSizeCommit = useCallback(async () => {
    if (!config) return;
    const value = Number(fontSizeInput);
    if (!Number.isFinite(value) || value < 10 || value > 24) {
      setFontSizeError(
        "Must be between 10 and 24 px. Reverted to previous value.",
      );
      setFontSizeInput(String(config.editor.fontSize));
      return;
    }
    setFontSizeError(null);
    document.documentElement.style.setProperty("--editor-font-size", `${value}px`);
    const { error } = await saveConfig({ ...config, editor: { ...config.editor, fontSize: value } });
    if (error) {
      setFontSizeError(`Save failed: ${error.message}. Reverted.`);
      setFontSizeInput(String(config.editor.fontSize));
      setSaveError(error.message);
    } else {
      setSaveError(null);
    }
  }, [config, fontSizeInput, saveConfig]);

  const handleLineHeightCommit = useCallback(async () => {
    if (!config) return;
    const value = Number(lineHeightInput);
    // Upper bound 3.0 matches server-side validation in config_validate.go
    if (!Number.isFinite(value) || value < 1.0 || value > 3.0) {
      setLineHeightError(
        "Must be between 1.0 and 3.0. Reverted to previous value.",
      );
      setLineHeightInput(String(config.editor.lineHeight));
      return;
    }
    setLineHeightError(null);
    document.documentElement.style.setProperty("--editor-line-height", `${value}`);
    const { error } = await saveConfig({ ...config, editor: { ...config.editor, lineHeight: value } });
    if (error) {
      setLineHeightError(`Save failed: ${error.message}. Reverted.`);
      setLineHeightInput(String(config.editor.lineHeight));
      setSaveError(error.message);
    } else {
      setSaveError(null);
    }
  }, [config, lineHeightInput, saveConfig]);

  const handleAutosaveMsCommit = useCallback(async () => {
    if (!config) return;
    const value = Number(autosaveMsInput);
    if (!Number.isFinite(value) || value < 250 || value > 10000) {
      setAutosaveMsError(
        "Must be between 250 and 10000 ms. Reverted to previous value.",
      );
      setAutosaveMsInput(String(config.editor.autosaveMs));
      return;
    }
    setAutosaveMsError(null);
    const { error } = await saveConfig({ ...config, editor: { ...config.editor, autosaveMs: value } });
    if (error) {
      setAutosaveMsError(`Save failed: ${error.message}. Reverted.`);
      setAutosaveMsInput(String(config.editor.autosaveMs));
      setSaveError(error.message);
    } else {
      setSaveError(null);
    }
  }, [config, autosaveMsInput, saveConfig]);

  const handleDailyFolderCommit = useCallback(async () => {
    if (!config) return;
    const { error } = await saveConfig({
      ...config,
      dailyNotes: { ...config.dailyNotes, folder: dailyFolder },
    });
    if (error) {
      setSaveError(error.message);
    } else {
      setSaveError(null);
    }
  }, [config, dailyFolder, saveConfig]);

  const handleDailyTemplateCommit = useCallback(async () => {
    if (!config) return;
    const { error } = await saveConfig({
      ...config,
      dailyNotes: { ...config.dailyNotes, template: dailyTemplate },
    });
    if (error) {
      setSaveError(error.message);
    } else {
      setSaveError(null);
    }
  }, [config, dailyTemplate, saveConfig]);

  const handleDisplayNameCommit = useCallback(async () => {
    if (!config) return;
    const { error } = await saveConfig({ ...config, display_name: displayName });
    if (error) {
      setSaveError(error.message);
    } else {
      setSaveError(null);
    }
  }, [config, displayName, saveConfig]);

  const handleThemeChange = useCallback(
    async (t: "dark" | "light") => {
      if (!config) return;
      applyTheme(t);
      const { error } = await saveConfig({ ...config, theme: t });
      if (error) {
        setSaveError(error.message);
      } else {
        setSaveError(null);
      }
    },
    [config, saveConfig],
  );

  const handleVimModeChange = useCallback(
    async (checked: boolean) => {
      if (!config) return;
      const { error } = await saveConfig({ ...config, editor: { ...config.editor, vimMode: checked } });
      if (error) {
        setSaveError(error.message);
      } else {
        setSaveError(null);
      }
    },
    [config, saveConfig],
  );

  const currentTheme = config?.theme ?? "dark";
  const vimMode = config?.editor.vimMode ?? false;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.6)",
          }}
        />
        <Dialog.Content
          aria-label="Settings"
          aria-describedby="settings-dialog-desc"
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            maxWidth: 560,
            width: "calc(100vw - 48px)",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            padding: 24,
            color: "var(--color-fg)",
            overflowY: "auto",
            maxHeight: "calc(100vh - 48px)",
          }}
        >
          <Dialog.Title
            style={{
              fontSize: 16,
              fontWeight: 600,
              lineHeight: 1.4,
              margin: 0,
              color: "var(--color-fg)",
            }}
          >
            Settings
          </Dialog.Title>

          {/* Visually-hidden description satisfies Radix a11y (aria-describedby) */}
          <Dialog.Description
            id="settings-dialog-desc"
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: "hidden",
              clip: "rect(0, 0, 0, 0)",
              whiteSpace: "nowrap",
              border: 0,
            }}
          >
            Change application settings — appearance, editor, daily notes, and general preferences.
          </Dialog.Description>

          {/* ── Save error banner ────────────────────────────────────────── */}
          {saveError && (
            <div
              role="alert"
              style={{
                marginTop: 12,
                padding: "8px 12px",
                background: "color-mix(in srgb, var(--color-destructive) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--color-destructive) 40%, transparent)",
                borderRadius: 6,
                fontSize: 13,
                color: "var(--color-destructive)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <AlertCircle size={14} aria-hidden="true" />
              <span>Settings could not be saved: {saveError}</span>
              <button
                type="button"
                onClick={() => setSaveError(null)}
                aria-label="Dismiss error"
                style={{
                  marginLeft: "auto",
                  background: "transparent",
                  border: "none",
                  color: "var(--color-destructive)",
                  cursor: "pointer",
                  padding: 0,
                  fontSize: 12,
                  fontFamily: "inherit",
                }}
              >
                ×
              </button>
            </div>
          )}

          {/* ── APPEARANCE ─────────────────────────────────────────────── */}
          <SectionDivider />
          <section>
            <Eyebrow text="APPEARANCE" />

            {/* Theme */}
            <div style={{ marginBottom: 16 }}>
              <div
                style={{ fontSize: 14, color: "var(--color-fg)", marginBottom: 4 }}
              >
                Theme
              </div>
              <div style={{ position: "relative" }}>
                <ThemeRadioRow
                  label="Dark"
                  value="dark"
                  selected={currentTheme === "dark"}
                  onSelect={() => { void handleThemeChange("dark"); }}
                />
                <ThemeRadioRow
                  label="Light"
                  value="light"
                  selected={currentTheme === "light"}
                  onSelect={() => { void handleThemeChange("light"); }}
                />
              </div>
            </div>

            {/* Editor font size */}
            <ControlRow label="Editor font size" htmlFor="settings-font-size">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  id="settings-font-size"
                  type="number"
                  min={10}
                  max={24}
                  aria-label="Editor font size"
                  aria-describedby="settings-font-size-helper"
                  value={fontSizeInput}
                  onChange={(e) => {
                    setFontSizeInput(e.target.value);
                    setFontSizeError(null);
                  }}
                  onBlur={() => { void handleFontSizeCommit(); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleFontSizeCommit();
                  }}
                  style={{ ...inputStyle, width: 72 }}
                />
                <span style={{ fontSize: 14, color: "var(--color-muted)" }}>
                  px
                </span>
              </div>
              <span
                id="settings-font-size-helper"
                style={{
                  fontSize: 12,
                  color: "var(--color-muted)",
                  display: "block",
                  marginTop: 4,
                }}
              >
                10–24 px
              </span>
              {fontSizeError && (
                <span
                  role="alert"
                  style={{
                    fontSize: 12,
                    color: "var(--color-destructive)",
                    display: "block",
                    marginTop: 4,
                  }}
                >
                  {fontSizeError}
                </span>
              )}
            </ControlRow>

            {/* Editor line height — 1.0–3.0, matches server validation */}
            <ControlRow label="Editor line height" htmlFor="settings-line-height">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  id="settings-line-height"
                  type="number"
                  min={1.0}
                  max={3.0}
                  step={0.1}
                  aria-label="Editor line height"
                  aria-describedby="settings-line-height-helper"
                  value={lineHeightInput}
                  onChange={(e) => {
                    setLineHeightInput(e.target.value);
                    setLineHeightError(null);
                  }}
                  onBlur={() => { void handleLineHeightCommit(); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleLineHeightCommit();
                  }}
                  style={{ ...inputStyle, width: 72 }}
                />
                <span style={{ fontSize: 14, color: "var(--color-muted)" }}>
                  ×
                </span>
              </div>
              <span
                id="settings-line-height-helper"
                style={{
                  fontSize: 12,
                  color: "var(--color-muted)",
                  display: "block",
                  marginTop: 4,
                }}
              >
                1.0–3.0
              </span>
              {lineHeightError && (
                <span
                  role="alert"
                  style={{
                    fontSize: 12,
                    color: "var(--color-destructive)",
                    display: "block",
                    marginTop: 4,
                  }}
                >
                  {lineHeightError}
                </span>
              )}
            </ControlRow>
          </section>

          {/* ── EDITOR ──────────────────────────────────────────────────── */}
          <SectionDivider />
          <section>
            <Eyebrow text="EDITOR" />

            {/* Autosave interval — RESTART BADGE */}
            <ControlRow
              label="Autosave interval"
              htmlFor="settings-autosave-ms"
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  id="settings-autosave-ms"
                  type="number"
                  min={250}
                  max={10000}
                  step={250}
                  aria-label="Autosave interval"
                  aria-describedby="settings-autosave-ms-helper"
                  value={autosaveMsInput}
                  onChange={(e) => {
                    setAutosaveMsInput(e.target.value);
                    setAutosaveMsError(null);
                  }}
                  onBlur={() => { void handleAutosaveMsCommit(); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleAutosaveMsCommit();
                  }}
                  style={{ ...inputStyle, width: 80 }}
                />
                <span style={{ fontSize: 14, color: "var(--color-muted)" }}>
                  ms
                </span>
                <RestartBadge />
              </div>
              <span
                id="settings-autosave-ms-helper"
                style={{
                  fontSize: 12,
                  color: "var(--color-muted)",
                  display: "block",
                  marginTop: 4,
                }}
              >
                250–10000 ms. Changes take effect after reload.
              </span>
              {autosaveMsError && (
                <span
                  role="alert"
                  style={{
                    fontSize: 12,
                    color: "var(--color-destructive)",
                    display: "block",
                    marginTop: 4,
                  }}
                >
                  {autosaveMsError}
                </span>
              )}
            </ControlRow>

            {/* Vim mode — RESTART BADGE + HONEST COPY */}
            <div style={{ marginBottom: 8 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <Switch.Root
                  checked={vimMode}
                  onCheckedChange={(checked) => { void handleVimModeChange(checked); }}
                  aria-label="Vim mode"
                  aria-describedby="vim-mode-helper"
                  style={{
                    width: 32,
                    height: 20,
                    backgroundColor: vimMode
                      ? "var(--color-accent)"
                      : "var(--color-border)",
                    borderRadius: 10,
                    border: "none",
                    cursor: "pointer",
                    position: "relative",
                    flexShrink: 0,
                    padding: 0,
                  }}
                >
                  <Switch.Thumb
                    style={{
                      display: "block",
                      width: 16,
                      height: 16,
                      backgroundColor: "var(--color-bg)",
                      borderRadius: "50%",
                      transition: "transform 150ms",
                      transform: vimMode
                        ? "translateX(14px)"
                        : "translateX(2px)",
                    }}
                  />
                </Switch.Root>
                <span
                  style={{ fontSize: 14, color: "var(--color-fg)", flex: 1 }}
                >
                  Vim mode
                </span>
                <RestartBadge />
              </div>
              {/* CRITICAL HONEST COPY: vim key bindings are NOT yet wired */}
              <p
                id="vim-mode-helper"
                style={{
                  fontSize: 12,
                  color: "var(--color-muted)",
                  margin: "0 0 8px 40px",
                  lineHeight: 1.5,
                }}
              >
                Your preference is saved. Vim key bindings are not yet active
                — they will be enabled in a future update.
              </p>
            </div>
          </section>

          {/* ── DAILY NOTES ─────────────────────────────────────────────── */}
          <SectionDivider />
          <section>
            <Eyebrow text="DAILY NOTES" />

            {/* Folder */}
            <ControlRow label="Folder" htmlFor="settings-daily-folder">
              <input
                id="settings-daily-folder"
                type="text"
                placeholder="daily"
                aria-label="Daily notes folder"
                value={dailyFolder}
                onChange={(e) => setDailyFolder(e.target.value)}
                onBlur={() => { void handleDailyFolderCommit(); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleDailyFolderCommit();
                }}
                style={{ ...inputStyle, width: "100%" }}
              />
            </ControlRow>

            {/* Template */}
            <div style={{ marginBottom: 8 }}>
              <label
                htmlFor="settings-daily-template"
                style={{
                  display: "block",
                  fontSize: 14,
                  color: "var(--color-fg)",
                  marginBottom: 4,
                }}
              >
                Template
              </label>
              <textarea
                id="settings-daily-template"
                value={dailyTemplate}
                onChange={(e) => setDailyTemplate(e.target.value)}
                onBlur={() => { void handleDailyTemplateCommit(); }}
                rows={4}
                spellCheck={false}
                aria-label="Daily note template"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "8px 12px",
                  fontFamily: "var(--font-mono)",
                  fontSize: 14,
                  lineHeight: 1.5,
                  background: "var(--color-bg)",
                  color: "var(--color-fg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 6,
                  outline: "none",
                  resize: "vertical",
                }}
              />
              <p
                style={{
                  fontSize: 12,
                  color: "var(--color-muted)",
                  margin: "4px 0",
                  lineHeight: 1.5,
                }}
              >
                {`Use {{date}} to insert today's date (e.g. 2026-06-13).`}
                {" "}
                <button
                  type="button"
                  onClick={() => {
                    const t = "# {{date}}\n\n";
                    setDailyTemplate(t);
                    if (!config) return;
                    void saveConfig({
                      ...config,
                      dailyNotes: { ...config.dailyNotes, template: t },
                    }).then(({ error }) => {
                      if (error) setSaveError(error.message);
                      else setSaveError(null);
                    });
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    color: "var(--color-accent)",
                    textDecoration: "underline",
                    cursor: "pointer",
                    fontSize: 12,
                    fontFamily: "inherit",
                  }}
                >
                  Reset to default
                </button>
              </p>
            </div>
          </section>

          {/* ── GENERAL ─────────────────────────────────────────────────── */}
          <SectionDivider />
          <section>
            <Eyebrow text="GENERAL" />

            {/* Display name */}
            <ControlRow label="Display name" htmlFor="settings-display-name">
              <input
                id="settings-display-name"
                type="text"
                placeholder="vault name"
                aria-label="Display name"
                aria-describedby="settings-display-name-helper"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onBlur={() => { void handleDisplayNameCommit(); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleDisplayNameCommit();
                }}
                style={{ ...inputStyle, width: "100%" }}
              />
              <span
                id="settings-display-name-helper"
                style={{
                  fontSize: 12,
                  color: "var(--color-muted)",
                  display: "block",
                  marginTop: 4,
                }}
              >
                Shown in the status bar and vault switcher.
              </span>
            </ControlRow>
          </section>

          {/* ── Footer / Close ──────────────────────────────────────────── */}
          <SectionDivider />
          <div
            style={{ display: "flex", justifyContent: "flex-end" }}
          >
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              style={{
                height: 32,
                padding: "0 12px",
                background: "var(--color-accent)",
                color: "var(--color-bg)",
                border: "none",
                borderRadius: 4,
                fontSize: 14,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
