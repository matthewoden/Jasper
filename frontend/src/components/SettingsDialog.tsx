/**
 * SettingsDialog — in-app settings panel (Radix Dialog modal).
 *
 * Fixed-header / scrolling-body / fixed-footer layout capped at the viewport
 * (SET2-01). Four sections (APPEARANCE / EDITOR / DAILY NOTES / GENERAL /
 * NETWORK), auto-persist on blur/Enter (no Save button), live CSS-var apply
 * for font/line height, deferred restart badges shown only when a
 * restart-pending field differs from the boot-baseline config captured at
 * first load (SET2-03).
 *
 * CRITICAL: Vim copy is HONEST — "not yet active — they will be enabled in a
 * future update." The preference is saved; key bindings are not yet wired.
 */
import * as Dialog from "@radix-ui/react-dialog";
import * as Switch from "@radix-ui/react-switch";
import { AlertCircle, X } from "lucide-react";
import { useState, useEffect, useCallback, useRef } from "react";
import { useConfig, type Config } from "../lib/useConfig";
import { useAccent } from "../lib/useAccent";

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

// ─── Accent swatches ──────────────────────────────────────────────────────
const ACCENT_SWATCHES = [
  { id: "purple", label: "Purple", hex: "#a78bfa" },
  { id: "sky",    label: "Sky",    hex: "#7dd3fc" },
  { id: "green",  label: "Green",  hex: "#34d399" },
  { id: "orange", label: "Orange", hex: "#fb923c" },
] as const;

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

// ─── Main component ────────────────────────────────────────────────────────
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { config, saveConfig } = useConfig();

  // Boot-baseline capture: assigned once on first non-null config, never updated.
  // Restart badges compare current values against this baseline (SET2-03 honest-signal).
  const bootBaselineRef = useRef<Config | null>(null);
  useEffect(() => {
    if (config && bootBaselineRef.current === null) {
      bootBaselineRef.current = config;
    }
  }, [config]);

  // useAccent always-mounted: boot-applies persisted accent/readingFont from config.
  const { accent, setAccent, readingFont, setReadingFont } = useAccent();

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
  const [bindAddress, setBindAddress] = useState("");

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
    setBindAddress(config.server?.bind ?? "127.0.0.1");
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

  const handleAccentChange = useCallback(
    async (id: string) => {
      const { error } = await setAccent(id);
      if (error) {
        setSaveError("Couldn't save accent preference. Changes will be lost on reload.");
      } else {
        setSaveError(null);
      }
    },
    [setAccent],
  );

  const handleReadingFontChange = useCallback(
    async (rf: string) => {
      const { error } = await setReadingFont(rf);
      if (error) {
        setSaveError("Couldn't save font preference. Changes will be lost on reload.");
      } else {
        setSaveError(null);
      }
    },
    [setReadingFont],
  );

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

  const handleBindAddressCommit = useCallback(async () => {
    if (!config?.server) return;
    const { error } = await saveConfig({
      ...config,
      server: { ...config.server, bind: bindAddress },
    });
    if (error) {
      setSaveError(error.message);
    } else {
      setSaveError(null);
    }
  }, [config, bindAddress, saveConfig]);

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

  const vimMode = config?.editor.vimMode ?? false;

  // ── Deferred restart-badge visibility (SET2-03) ──────────────────────
  // Badges shown only when current value differs from the boot baseline.
  // Live-apply fields (accent, readingFont, fontSize, lineHeight) never show a badge.
  // autosaveMsInput and bindAddress use input state so the badge appears immediately
  // on typing (before blur/save). vimMode is a toggle that saves synchronously,
  // so comparing config (optimistically updated) is sufficient.
  const showAutosaveBadge =
    bootBaselineRef.current !== null &&
    Number(autosaveMsInput) !== bootBaselineRef.current.editor.autosaveMs;

  const showVimModeBadge =
    bootBaselineRef.current !== null &&
    config?.editor.vimMode !== bootBaselineRef.current.editor.vimMode;

  const showBindBadge =
    bootBaselineRef.current !== null &&
    bindAddress !== bootBaselineRef.current.server?.bind;

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
            maxHeight: "calc(100vh - 48px)",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            color: "var(--color-fg)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* ── Fixed header (flex-shrink: 0) ── */}
          <div
            style={{
              padding: "16px 24px",
              borderBottom: "1px solid var(--color-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexShrink: 0,
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
            <button
              type="button"
              aria-label="Close settings"
              onClick={() => onOpenChange(false)}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--color-muted)",
                cursor: "pointer",
                padding: 4,
                borderRadius: 4,
              }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          {/* ── Scrolling body (flex: 1; min-height: 0) ──
              CRITICAL: min-height: 0 prevents the body from overflowing the dialog.
              Without it, flex: 1 + overflow-y: auto still overflows (Pitfall 1). */}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 24 }}>
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
                <span>{saveError}</span>
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

              {/* Accent color */}
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{ fontSize: 14, color: "var(--color-fg)", marginBottom: 8 }}
                >
                  Accent color
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {ACCENT_SWATCHES.map(({ id, label, hex }) => {
                    const selected = accent === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-label={label}
                        aria-pressed={selected}
                        onClick={() => { void handleAccentChange(id); }}
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

              {/* Reading font (SET2-04: live preview paragraph below pills) */}
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{ fontSize: 13, color: "var(--color-muted)", marginBottom: 4 }}
                >
                  Reading font
                </div>
                <div
                  style={{ fontSize: 12, color: "var(--color-muted)", marginBottom: 8 }}
                >
                  Applies to note content only
                </div>
                <div role="group" aria-label="Reading font" style={{ display: "flex", gap: 4 }}>
                  {(["sans", "serif"] as const).map((rf) => {
                    const active = readingFont === rf;
                    return (
                      <button
                        key={rf}
                        type="button"
                        aria-pressed={active}
                        onClick={() => { void handleReadingFontChange(rf); }}
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
                {/* SET2-04: live preview — fontFamily var updates synchronously when toggle fires */}
                <p
                  aria-live="polite"
                  style={{
                    fontFamily: "var(--font-reading)",
                    fontSize: 14,
                    lineHeight: 1.5,
                    color: "var(--color-fg)",
                    marginTop: 8,
                    padding: "8px 12px",
                    background: "var(--color-bg)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                  }}
                >
                  The quick brown fox jumps over the lazy dog.
                </p>
              </div>

              {/* SET2-02: Editor font-size + line-height inline on one row */}
              <ControlRow label="Editor" htmlFor="settings-font-size">
                <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
                  {/* Group A: font-size */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
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
                      style={{ fontSize: 12, color: "var(--color-muted)" }}
                    >
                      10–24 px
                    </span>
                    {fontSizeError && (
                      <span
                        role="alert"
                        style={{ fontSize: 12, color: "var(--color-destructive)" }}
                      >
                        {fontSizeError}
                      </span>
                    )}
                  </div>
                  {/* Group B: line-height */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
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
                      style={{ fontSize: 12, color: "var(--color-muted)" }}
                    >
                      1.0–3.0
                    </span>
                    {lineHeightError && (
                      <span
                        role="alert"
                        style={{ fontSize: 12, color: "var(--color-destructive)" }}
                      >
                        {lineHeightError}
                      </span>
                    )}
                  </div>
                </div>
              </ControlRow>
            </section>

            {/* ── EDITOR ──────────────────────────────────────────────────── */}
            <SectionDivider />
            <section>
              <Eyebrow text="EDITOR" />

              {/* Autosave interval — deferred restart badge (SET2-03) */}
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
                  {showAutosaveBadge && <RestartBadge />}
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

              {/* Vim mode — deferred restart badge + HONEST COPY */}
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
                  {showVimModeBadge && <RestartBadge />}
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

            {/* ── NETWORK ─────────────────────────────────────────────────── */}
            <SectionDivider />
            <section>
              <Eyebrow text="NETWORK" />

              <ControlRow label="Bind address" htmlFor="settings-bind-address">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    id="settings-bind-address"
                    type="text"
                    placeholder="127.0.0.1"
                    aria-label="Bind address"
                    aria-describedby="settings-bind-helper"
                    value={bindAddress}
                    onChange={(e) => setBindAddress(e.target.value)}
                    onBlur={() => { void handleBindAddressCommit(); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleBindAddressCommit();
                    }}
                    style={{ ...inputStyle, width: "100%", fontFamily: "var(--font-mono)" }}
                  />
                  {showBindBadge && <RestartBadge />}
                </div>
                <span
                  id="settings-bind-helper"
                  style={{ fontSize: 12, color: "var(--color-muted)", display: "block", marginTop: 4 }}
                >
                  Loopback only (127.0.0.1) or all interfaces (0.0.0.0).
                </span>
                <span style={{ fontSize: 12, color: "var(--color-muted)", display: "block", marginTop: 2 }}>
                  Requires a server restart to take effect.
                </span>
              </ControlRow>

              {/* Beyond-loopback warning — driven by PERSISTED config value, not local input state */}
              {config?.server?.bind && config.server.bind !== "127.0.0.1" &&
               config.server.bind !== "localhost" && config.server.bind !== "::1" && (
                <div
                  role="alert"
                  style={{
                    padding: "8px 12px",
                    background: "var(--color-warning-surface)",
                    border: "1px solid var(--color-warning)",
                    borderRadius: 6,
                    color: "var(--color-warning)",
                    fontSize: 14,
                    lineHeight: 1.4,
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    marginTop: 8,
                  }}
                >
                  <AlertCircle size={14} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>
                    Jasper is exposed on all network interfaces. Only enable LAN access on trusted networks.
                  </span>
                </div>
              )}
            </section>
          </div>

          {/* ── Fixed footer (flex-shrink: 0) ── */}
          <div
            style={{
              padding: "12px 24px",
              borderTop: "1px solid var(--color-border)",
              display: "flex",
              justifyContent: "flex-end",
              flexShrink: 0,
            }}
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
              Done
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
