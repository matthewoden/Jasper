/**
 * VaultCreatePane — the "Create new" tab of VaultPicker.
 *
 * Inherits the 08-04 four-section structure and 08-16 polish VERBATIM:
 *   1. Vault folder path (absolute path input with validateVaultPath)
 *   2. Theme radio (dark/light; default dark per D-06)
 *   3. MCP enable + Tier-1/Tier-2 grants (08-16 N8 copy via vaultCopy.ts)
 *   4. Daily-note template with {{date}} token (08-16 N3: REQUIRED eyebrow)
 *
 * SECURITY-06: validateVaultPath runs client-side before POST /vault/create.
 * Backend repeats every rule (defense-in-depth).
 *
 * Plan 08-17c Task 2.
 */

import { useState } from "react";
import { vaultApi, validateVaultPath } from "../../lib/vaultApi";
import {
  TIER_1_LABEL,
  TIER_2_LABEL,
  DAILY_TEMPLATE_REQUIRED_LABEL,
  DAILY_TEMPLATE_HELP,
} from "./vaultCopy";

export interface VaultCreatePaneProps {
  onCreated: () => void;
}

// Grant tiers for MCP section (mirrors SetupApp draft shape)
interface GrantDraft {
  folder: string;
  level: 1 | 2;
}

const SECTION_EYEBROW_STYLE: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-muted)",
  letterSpacing: 0.4,
  textTransform: "uppercase",
  marginBottom: 6,
};

const HELPER_STYLE: React.CSSProperties = {
  fontSize: 14,
  color: "var(--color-muted)",
  margin: "0 0 10px",
  lineHeight: 1.5,
};

export function VaultCreatePane({ onCreated }: VaultCreatePaneProps) {
  // Section 1: vault path
  const [path, setPath] = useState("");

  // Section 2: theme
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  // Section 3: MCP
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [grants, setGrants] = useState<GrantDraft[]>([]);

  // Section 4: daily note template
  const [dailyTemplate, setDailyTemplate] = useState("");

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
        mcp_enabled: mcpEnabled,
      });
      onCreated();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to create vault.";
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddFolder = () => {
    const raw = window.prompt("Folder path (relative, e.g. projects):");
    if (raw === null) return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (grants.some((g) => g.folder.toLowerCase() === trimmed.toLowerCase())) {
      return;
    }
    setGrants((prev) => [...prev, { folder: trimmed, level: 1 }]);
  };

  const handleRemoveGrant = (index: number) => {
    setGrants((prev) => prev.filter((_, i) => i !== index));
  };

  const handleChangeLevel = (index: number, level: 1 | 2) => {
    setGrants((prev) => prev.map((g, i) => (i === index ? { ...g, level } : g)));
  };

  return (
    <div>
      {/* Section 1: Vault folder path */}
      <section style={{ marginBottom: 24 }}>
        <div style={SECTION_EYEBROW_STYLE}>VAULT FOLDER</div>
        <p style={HELPER_STYLE}>
          Choose an existing empty folder or type a new path. Jasper will
          initialize the vault there.
        </p>
        <label>
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/you/Documents/Notes"
            data-testid="vault-create-path-input"
          />
        </label>
        {!pathValidation.ok && path !== "" && (
          <div style={{ fontSize: 12, color: "var(--color-destructive)", marginTop: 4 }}>
            {pathValidation.message}
          </div>
        )}
      </section>

      {/* Section 2: Theme */}
      <section style={{ marginBottom: 24 }}>
        <div style={SECTION_EYEBROW_STYLE}>THEME</div>
        <p style={HELPER_STYLE}>You can switch any time.</p>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14 }}>
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

      {/* Section 3: MCP */}
      <section style={{ marginBottom: 24 }}>
        <div style={SECTION_EYEBROW_STYLE}>AI ACCESS (MCP)</div>
        <p style={HELPER_STYLE}>
          Optional. Lets local AI tools read your notes — and, in folders you
          pick, write to them. Off by default.
        </p>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={mcpEnabled}
            onChange={(e) => setMcpEnabled(e.target.checked)}
            aria-label="Enable MCP server for AI tools"
          />
          <span>Enable MCP server for AI tools</span>
        </label>

        {mcpEnabled && (
          <div style={{ marginTop: 12 }}>
            <p style={{ ...HELPER_STYLE, margin: "0 0 8px" }}>
              Pick folders where AI can create and edit notes.
            </p>
            {/* Tier descriptions — always visible when MCP is enabled so user understands options (D-19) */}
            <p style={{ fontSize: 12, color: "var(--color-muted)", margin: "0 0 4px" }}>
              <strong>Tier 1:</strong> {TIER_1_LABEL}
            </p>
            <p style={{ fontSize: 12, color: "var(--color-muted)", margin: "0 0 8px" }}>
              <strong>Tier 2:</strong> {TIER_2_LABEL}
            </p>
            {grants.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--color-muted)", fontStyle: "italic", margin: "6px 0" }}>
                No folders granted yet. (Reads are global once MCP is on.)
              </div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
                {grants.map((g, idx) => (
                  <li
                    key={`${g.folder}-${idx}`}
                    style={{ display: "flex", alignItems: "center", gap: 8, height: 32, fontSize: 13 }}
                  >
                    <span style={{ flex: 1 }}>{g.folder}</span>
                    <select
                      value={g.level}
                      aria-label={`Access level for ${g.folder}`}
                      onChange={(e) =>
                        handleChangeLevel(idx, Number(e.target.value) === 2 ? 2 : 1)
                      }
                      style={{
                        fontSize: 12,
                        background: g.level === 2 ? "var(--color-ai-grant-strong)" : "var(--color-ai-grant)",
                        color: "var(--color-bg)",
                        border: "none",
                        borderRadius: 999,
                        padding: "2px 8px",
                        fontWeight: 600,
                      }}
                    >
                      <option value={1}>{TIER_1_LABEL}</option>
                      <option value={2}>{TIER_2_LABEL}</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => handleRemoveGrant(idx)}
                      aria-label={`Remove ${g.folder}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" onClick={handleAddFolder}>
              Add folder…
            </button>
          </div>
        )}
      </section>

      {/* Section 4: Daily note template */}
      <section style={{ marginBottom: 24 }}>
        <div style={SECTION_EYEBROW_STYLE}>DAILY NOTES</div>
        <p style={HELPER_STYLE}>
          Each day gets a fresh note. Customize the starter template here.
        </p>
        <p style={{ fontSize: 12, color: "var(--color-muted)", margin: "0 0 8px", lineHeight: 1.5 }}>
          {DAILY_TEMPLATE_HELP}
        </p>

        {/* REQUIRED eyebrow — 08-16 N3 verbatim */}
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: "var(--color-muted)",
            marginBottom: 4,
          }}
        >
          {DAILY_TEMPLATE_REQUIRED_LABEL}
        </div>

        <label htmlFor="vault-create-daily-template">
          Daily note template
          <textarea
            id="vault-create-daily-template"
            aria-label="Daily note template"
            value={dailyTemplate}
            onChange={(e) => setDailyTemplate(e.target.value)}
            rows={4}
            spellCheck={false}
          />
        </label>
      </section>

      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        aria-label="Create vault"
      >
        {submitting ? "Creating…" : "Create vault"}
      </button>

      {submitError && (
        <div role="alert" style={{ color: "var(--color-destructive)", fontSize: 12, marginTop: 8 }}>
          {submitError}
        </div>
      )}
    </div>
  );
}
