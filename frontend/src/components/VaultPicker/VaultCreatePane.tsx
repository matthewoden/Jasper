/**
 * VaultCreatePane — "Create new" tab of VaultPicker.
 *
 * Three sections: vault folder path, theme (live-applies on radio change),
 * daily-note template. MCP grants belong on existing folders, not at
 * creation time — managed post-creation via the folder right-click menu.
 *
 * validateVaultPath runs client-side before POST; backend repeats every rule
 * (defense-in-depth).
 */

import { useState } from "react";
import { vaultApi, validateVaultPath } from "../../lib/vaultApi";
import { applyTheme } from "../../lib/useTheme";
import { FolderPicker } from "./FolderPicker";

export interface VaultCreatePaneProps {
  onCreated: () => void;
}


const DEFAULT_DAILY_TEMPLATE = "# {{date}}\n\n";

const SECTION_EYEBROW_STYLE: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-muted)",
  letterSpacing: 0.4,
  textTransform: "uppercase",
  marginBottom: 6,
};

const HELPER_STYLE: React.CSSProperties = {
  fontSize: 13,
  color: "var(--color-muted)",
  margin: "0 0 10px",
  lineHeight: 1.5,
};

export function VaultCreatePane({ onCreated }: VaultCreatePaneProps) {
  const [path, setPath] = useState("");
  const [browsing, setBrowsing] = useState(false);

  const [theme, setThemeState] = useState<"dark" | "light">("dark");
  const setTheme = (t: "dark" | "light") => {
    setThemeState(t);
    applyTheme(t);
  };

  const [dailyTemplate, setDailyTemplate] = useState(DEFAULT_DAILY_TEMPLATE);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const pathValidation = validateVaultPath(path);
  const canSubmit = pathValidation.ok && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      await vaultApi.create({
        path,
        theme,
        daily_template: dailyTemplate,
      });
      onCreated();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to create vault.";
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
    >
      <section style={{ marginBottom: 24 }}>
        <div style={SECTION_EYEBROW_STYLE}>Vault folder</div>
        <p style={HELPER_STYLE}>
          Choose an existing empty folder or type a new absolute path. Jasper
          initializes the vault there.
        </p>
        <label className="vault-picker-field-label" htmlFor="vault-create-path">
          Absolute path
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id="vault-create-path"
            className="vault-picker-input"
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/you/Documents/Jasper"
            data-testid="vault-create-path-input"
            autoFocus
            style={{ flex: 1 }}
          />
          <button
            type="button"
            onClick={() => setBrowsing(true)}
            data-testid="vault-create-browse"
            style={{
              appearance: "none",
              background: "transparent",
              color: "var(--color-fg)",
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              padding: "8px 14px",
              fontSize: 14,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Browse…
          </button>
        </div>
        {!pathValidation.ok && path !== "" && (
          <div style={{ fontSize: 12, color: "var(--color-destructive)", marginTop: 4 }}>
            {pathValidation.message}
          </div>
        )}
        <FolderPicker
          open={browsing}
          initialPath={path || undefined}
          onCancel={() => setBrowsing(false)}
          onSelect={(p) => {
            setPath(p);
            setBrowsing(false);
          }}
          onOpenVault={(p) => {
            void (async () => {
              try {
                await vaultApi.open(p);
                window.location.reload();
              } catch (e) {
                setSubmitError(e instanceof Error ? e.message : "Failed to open vault.");
                setBrowsing(false);
              }
            })();
          }}
        />
      </section>

      <section style={{ marginBottom: 24 }}>
        <div style={SECTION_EYEBROW_STYLE}>Theme</div>
        <p style={HELPER_STYLE}>Preview applies immediately. You can switch any time.</p>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14, marginBottom: 4 }}>
          <input
            type="radio"
            name="vault-create-theme"
            value="dark"
            checked={theme === "dark"}
            onChange={() => setTheme("dark")}
            aria-label="Dark"
          />
          <span>Dark</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14 }}>
          <input
            type="radio"
            name="vault-create-theme"
            value="light"
            checked={theme === "light"}
            onChange={() => setTheme("light")}
            aria-label="Light"
          />
          <span>Light</span>
        </label>
      </section>

      <section style={{ marginBottom: 24 }}>
        <div style={SECTION_EYEBROW_STYLE}>Daily notes</div>
        <p style={HELPER_STYLE}>
          Each day gets a fresh note. Use <code>{"{{date}}"}</code> for the
          YYYY-MM-DD stamp. Default works for most setups — edit if you want a
          different starter.
        </p>
        <label className="vault-picker-field-label" htmlFor="vault-create-daily-template">
          Template
        </label>
        <textarea
          id="vault-create-daily-template"
          className="vault-picker-textarea"
          aria-label="Daily note template"
          value={dailyTemplate}
          onChange={(e) => setDailyTemplate(e.target.value)}
          rows={4}
          spellCheck={false}
        />
      </section>

      <button
        type="submit"
        className="vault-picker-button-primary"
        disabled={!canSubmit}
        aria-label="Create vault"
        data-testid="vault-create-submit"
      >
        {submitting ? "Creating…" : "Create vault"}
      </button>

      {submitError && (
        <div role="alert" style={{ color: "var(--color-destructive)", fontSize: 12, marginTop: 8 }}>
          {submitError}
        </div>
      )}
    </form>
  );
}
