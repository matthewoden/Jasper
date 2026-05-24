/**
 * VaultOpenPane — text input + validate + open for an existing vault folder.
 *
 * Path validation runs client-side via validateVaultPath (5-rule pipeline)
 * before submitting to the backend (SECURITY-06 defense-in-depth).
 *
 * Plan 08-17c Task 2.
 */

import { useEffect, useState } from "react";
import { vaultApi, validateVaultPath } from "../../lib/vaultApi";

export interface VaultOpenPaneProps {
  initialPath?: string;
  onOpened: () => void;
}

export function VaultOpenPane({
  initialPath = "",
  onOpened,
}: VaultOpenPaneProps) {
  const [path, setPath] = useState(initialPath);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Sync initialPath changes (e.g. when Reconnect pre-fills the path)
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
      <label>
        Absolute path to the vault folder
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/Users/you/Documents/Notes"
          data-testid="vault-open-input"
        />
      </label>
      {!validation.ok && path !== "" && (
        <div className="vault-picker-error">{validation.message}</div>
      )}
      {error && <div className="vault-picker-error">{error}</div>}
      <button type="submit" disabled={!canSubmit} data-testid="vault-open-submit">
        Open
      </button>
    </form>
  );
}
