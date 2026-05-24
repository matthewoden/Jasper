/**
 * VaultCreatePane — the "Create new" tab of VaultPicker.
 *
 * Three sections per UAT-2 #1d feedback:
 *   1. Vault folder path (absolute path input with validateVaultPath)
 *   2. Theme radio (dark/light; default dark per D-06) — applies live so the
 *      user sees the choice before submitting (no save round-trip).
 *   3. Daily-note template with sensible default (`# {{date}}\n\n`)
 *
 * MCP grants were moved OUT of vault creation per UAT-2 #1d ("a new vault is
 * always empty; MCP grants belong on existing folders"). The wizard still
 * posts `mcp_enabled: false`; MCP is enabled and granted from the running app
 * (TreeRowMenu "Grant AI access" — Plan 08-10).
 *
 * SECURITY-06: validateVaultPath runs client-side before POST /vault/create.
 * Backend repeats every rule (defense-in-depth).
 *
 * Plan 08-17c Task 2 + UAT-2 #1d rework.
 */

import { useState } from "react";
import { vaultApi, validateVaultPath } from "../../lib/vaultApi";
import { applyTheme } from "../../lib/useTheme";
import { FolderPicker } from "./FolderPicker";

export interface VaultCreatePaneProps {
  onCreated: () => void;
}

// Daily-template default mirrors config.Defaults() in backend/internal/config/defaults.go
// so a user who keeps the default ends up with the same template the backend
// would have written via the legacy bootstrap path.
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
  // Section 1: vault path. Set via the Browse modal or typed directly.
  const [path, setPath] = useState("");
  const [browsing, setBrowsing] = useState(false);

  // Section 2: theme. Live-apply on change so the modal flips as the radio
  // is clicked — feedback before commit.
  const [theme, setThemeState] = useState<"dark" | "light">("dark");
  const setTheme = (t: "dark" | "light") => {
    setThemeState(t);
    applyTheme(t);
  };

  // Section 3: daily template, pre-filled with the same default the backend uses.
  const [dailyTemplate, setDailyTemplate] = useState(DEFAULT_DAILY_TEMPLATE);

  // Submit state
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
        // MCP stays off at vault-creation time (UAT-2 #1d). Owner grants
        // folders from TreeRowMenu after the vault is open.
        mcp_enabled: false,
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
      {/* Section 1: Vault folder path */}
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
        />
      </section>

      {/* Section 2: Theme — live preview */}
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

      {/* Section 3: Daily note template */}
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
