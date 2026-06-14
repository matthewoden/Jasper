/**
 * VaultOpenPane — type or paste an absolute path to an existing vault and open it.
 * validateVaultPath runs client-side before submitting (backend repeats for defense-in-depth).
 */

import { useEffect, useState } from "react";
import { vaultApi, validateVaultPath } from "../../lib/vaultApi";
import { FolderPicker } from "./FolderPicker";

export interface VaultOpenPaneProps {
  initialPath?: string;
  onOpened: () => void;
}

const HELPER_STYLE: React.CSSProperties = {
  fontSize: 13,
  color: "var(--color-muted)",
  margin: "0 0 10px",
  lineHeight: 1.5,
};

export function VaultOpenPane({
  initialPath = "",
  onOpened,
}: VaultOpenPaneProps) {
  const [path, setPath] = useState(initialPath);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    setPath(initialPath);
  }, [initialPath]);

  const validation = validateVaultPath(path);
  const canSubmit = validation.ok && !submitting;

  const handleSubmit = async () => {
    setError("");
    setSubmitting(true);
    try {
      await vaultApi.open(path);
      onOpened();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to open vault.";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) void handleSubmit();
      }}
    >
      <p style={HELPER_STYLE}>
        Point Jasper at a folder that already contains a vault (a{" "}
        <code>.jasper/</code> subdirectory). Use an absolute path.
      </p>
      <label className="vault-picker-field-label" htmlFor="vault-open-path">
        Vault folder
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          id="vault-open-path"
          className="vault-picker-input"
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/Users/you/Documents/Jasper"
          data-testid="vault-open-input"
          autoFocus
          style={{ flex: 1 }}
        />
        <button
          type="button"
          onClick={() => setBrowsing(true)}
          data-testid="vault-open-browse"
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
              setError(e instanceof Error ? e.message : "Failed to open vault.");
              setBrowsing(false);
            }
          })();
        }}
      />
      {!validation.ok && path !== "" && (
        <div className="vault-picker-error" style={{ marginTop: 8 }}>
          {validation.message}
        </div>
      )}
      {error && (
        <div className="vault-picker-error" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
      <button
        type="submit"
        className="vault-picker-button-primary"
        disabled={!canSubmit}
        data-testid="vault-open-submit"
        style={{ marginTop: 16 }}
      >
        Open vault
      </button>
    </form>
  );
}
