/**
 * SettingsDialogShell — composes the persistent left-nav Settings dialog
 * (D-19 locked 920x628 frame, 216px nav column, 56px header rows) around the
 * four section panes. Owns the single `useConfig` instance and the
 * save-error banner — replaces the retired `SettingsDialog.tsx`. The Server
 * section and its restart-pending signal were retired by ADR-002
 * (2026-07-26); Phase 36 reintroduces a Server pane with a different control
 * set.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { AlertCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  applyAccent,
  applyReadingFont,
  persistAccentBootstrap,
  persistReadingFontBootstrap,
} from "../../lib/useAccent";
import { useConfig, type Config } from "../../lib/useConfig";
import { getVaultAbout, type VaultAbout } from "../../lib/vaultAboutApi";
import { AboutSection } from "./AboutSection";
import { AppearanceSection } from "./AppearanceSection";
import { DailyNotesSection } from "./DailyNotesSection";
import { DEFAULT_CONFIG } from "./defaults";
import { EditorSection } from "./EditorSection";
import { NavColumn } from "./NavColumn";
import { PaneHeader } from "./PaneHeader";
import { ResetConfirmDialog } from "./ResetConfirmDialog";
import { SECTIONS, type SectionId } from "./sections";

// Fields a per-section Reset (D-07/D-10/D-12) is allowed to overwrite, built
// from the CURRENT config with only the named fields swapped to
// DEFAULT_CONFIG's values — never a wholesale DEFAULT_CONFIG spread, which
// would silently wipe every section the user did not ask to reset.
//
// MCP write grants live in the `mcp_write_grants` SQLite table with no
// representation in `Config` (D-09) — a Config-only write structurally
// cannot reach them, so no defensive "skip grants" branch is needed here.
function buildResetPatch(section: SectionId, config: Config): Partial<Config> {
  switch (section) {
    case "appearance":
      return {
        accent: DEFAULT_CONFIG.accent,
        readingFont: DEFAULT_CONFIG.readingFont,
        editor: {
          ...config.editor,
          fontSize: DEFAULT_CONFIG.editor.fontSize,
          lineHeight: DEFAULT_CONFIG.editor.lineHeight,
        },
      };
    case "editor":
      return {
        editor: { ...config.editor, autosaveMs: DEFAULT_CONFIG.editor.autosaveMs },
      };
    case "dailyNotes":
      return {
        dailyNotes: {
          folder: DEFAULT_CONFIG.dailyNotes.folder,
          template: DEFAULT_CONFIG.dailyNotes.template,
        },
      };
    default:
      return {};
  }
}

export interface SettingsDialogShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const hiddenStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export function SettingsDialogShell({ open, onOpenChange }: SettingsDialogShellProps) {
  const { config, saveConfig } = useConfig();
  const [activeSection, setActiveSection] = useState<SectionId>("appearance");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  // NavColumn's footer caption (UI-SPEC "{vault} · v{app version}") needs
  // to be visible from any pane, not just About — reuse the same typed
  // GET /vault/about call AboutSection makes (no new endpoint, no second
  // useConfig instance) and fire it once per dialog open.
  const [vaultAbout, setVaultAbout] = useState<VaultAbout | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getVaultAbout().then((res) => {
      if (!cancelled && res.data) {
        setVaultAbout(res.data);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Settings always opens on Appearance (D-20) — no persisted or
  // session-remembered active section. Resetting on close (rather than on
  // open) means a mid-session reopen never flashes the previous section.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setActiveSection("appearance");
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const handleResetSection = useCallback(
    async (section: SectionId) => {
      if (!config) return;
      const patch = buildResetPatch(section, config);
      const { error } = await saveConfig({ ...config, ...patch });
      if (error) {
        setSaveError(`Couldn't save your changes: ${error.message}.`);
        return;
      }
      setSaveError(null);
      // Live-apply fields (CSS vars + localStorage bootstrap keys) aren't
      // covered by the config write alone — re-run the same apply/persist
      // helpers AppearanceSection uses so the screen matches the reset
      // config instead of waiting for a reload.
      if (section === "appearance") {
        applyAccent(DEFAULT_CONFIG.accent);
        persistAccentBootstrap(DEFAULT_CONFIG.accent);
        applyReadingFont(DEFAULT_CONFIG.readingFont);
        persistReadingFontBootstrap(DEFAULT_CONFIG.readingFont);
        document.documentElement.style.setProperty(
          "--editor-font-size",
          `${DEFAULT_CONFIG.editor.fontSize}px`,
        );
        document.documentElement.style.setProperty(
          "--editor-line-height",
          `${DEFAULT_CONFIG.editor.lineHeight}`,
        );
      }
    },
    [config, saveConfig],
  );

  const activeMeta = SECTIONS.find((s) => s.id === activeSection);

  function renderActivePane() {
    // Never mount a pane with a null config — every pane's SectionProps
    // declares config as non-null.
    if (!config) return null;
    switch (activeSection) {
      case "appearance":
        return (
          <AppearanceSection config={config} saveConfig={saveConfig} onSaveError={setSaveError} />
        );
      case "editor":
        return <EditorSection config={config} saveConfig={saveConfig} onSaveError={setSaveError} />;
      case "dailyNotes":
        return (
          <DailyNotesSection config={config} saveConfig={saveConfig} onSaveError={setSaveError} />
        );
      case "about":
        return (
          <AboutSection
            config={config}
            saveConfig={saveConfig}
            onSaveError={setSaveError}
            visible={activeSection === "about"}
          />
        );
      default:
        return null;
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay style={{ position: "fixed", inset: 0, background: "rgba(0, 0, 0, 0.5)" }} />
        {/* No hand-written id / aria-describedby here: Dialog.Description
            spreads its props AFTER its own `id`, so overriding it detaches
            Radix's DescriptionWarning lookup and logs a "Missing
            Description" warning on every open. Letting Radix wire both ends
            keeps the a11y tree identical and the console clean. */}
        <Dialog.Content
          aria-label="Settings"
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: 920,
            height: 628,
            maxWidth: "94%",
            maxHeight: "82vh",
            display: "flex",
            flexDirection: "row",
            overflow: "hidden",
            background: "var(--color-surface-raised)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            color: "var(--color-fg)",
          }}
        >
          {/* Visible "Settings" text lives in NavColumn's header row; this
              satisfies Radix's a11y expectation of a Dialog.Title without a
              second visible heading. */}
          <Dialog.Title style={hiddenStyle}>Settings</Dialog.Title>
          <Dialog.Description style={hiddenStyle}>
            Change application settings — appearance, editor, and daily notes.
          </Dialog.Description>

          <NavColumn
            activeSection={activeSection}
            onSelect={setActiveSection}
            vaultName={vaultAbout?.vaultName}
            appVersion={vaultAbout?.appVersion}
          />

          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <PaneHeader
              title={activeMeta?.label ?? ""}
              subtitle={activeMeta?.subtitle ?? ""}
              showReset={activeMeta?.hasReset ?? false}
              onReset={() => setResetDialogOpen(true)}
              onClose={() => handleOpenChange(false)}
            />

            {/* CRITICAL: min-height: 0 alongside flex: 1 — flex: 1 alone
                still overflows the fixed 920x628 frame without it. */}
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 24 }}>
              {saveError && (
                <div
                  role="alert"
                  style={{
                    marginBottom: 16,
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
              {renderActivePane()}
            </div>
          </div>

          {activeMeta && (
            <ResetConfirmDialog
              open={resetDialogOpen}
              onOpenChange={setResetDialogOpen}
              sectionLabel={activeMeta.label}
              onConfirm={() => {
                void handleResetSection(activeSection);
              }}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
