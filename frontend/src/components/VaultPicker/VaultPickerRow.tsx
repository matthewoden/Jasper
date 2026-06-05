/**
 * VaultPickerRow — renders one RecentVaultEntry in the picker's Recent tab.
 *
 * V11: missing=true → row is greyed (opacity 0.6) with "Folder not found" caption
 * plus Reconnect and Remove action buttons.
 *
 * Plan 08-17c Task 2.
 * Plan 08-17d: `mode` prop added. "switch" mode calls vaultApi.switch (hot-swap
 * while a vault is already open); "boot" mode calls vaultApi.open (first open
 * when no vault is active). The WS vault.switching event drives the overlay;
 * window.location.reload fires on vault.switched (or 10s failsafe).
 */

import { vaultApi } from "../../lib/vaultApi";
import type { components } from "../../api/schema";

type RecentVaultEntry = components["schemas"]["RecentVaultEntry"];

export interface VaultPickerRowProps {
  entry: RecentVaultEntry;
  onReconnect: (path: string) => void;
  onForgotten: () => void;
  /**
   * "boot" — no vault is open; vaultApi.open is called + page reloads (17c behaviour).
   * "switch" — a vault is already open; vaultApi.switch is called; the WS event
   * drives the overlay and the SPA reload (17d behaviour).
   * Defaults to "boot" for backward-compat.
   */
  mode?: "boot" | "switch";
}

export function VaultPickerRow({
  entry,
  onReconnect,
  onForgotten,
  mode = "boot",
}: VaultPickerRowProps) {
  const handleOpen = async () => {
    if (mode === "switch") {
      await vaultApi.switch(entry.path);
    } else {
      await vaultApi.open(entry.path);
      window.location.reload();
    }
  };

  const handleForget = async () => {
    await vaultApi.forget(entry.path);
    onForgotten();
  };

  if (entry.missing) {
    return (
      <div
        className="vault-picker-row vault-picker-row--missing"
        data-testid={`vault-row-missing-${entry.path}`}
        style={{ opacity: 0.6 }}
      >
        <div className="vault-picker-row__name">{entry.display_name}</div>
        <div className="vault-picker-row__path">{entry.path}</div>
        <div className="vault-picker-row__caption">Folder not found</div>
        <div className="vault-picker-row__actions">
          <button type="button" onClick={() => onReconnect(entry.path)}>
            Reconnect…
          </button>
          <button type="button" onClick={() => void handleForget()}>
            Remove
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="vault-picker-row"
      data-testid={`vault-row-${entry.path}`}
      onClick={() => void handleOpen()}
    >
      <div className="vault-picker-row__name">{entry.display_name}</div>
      <div className="vault-picker-row__path">{entry.path}</div>
      <div className="vault-picker-row__last">
        Last opened {new Date(entry.last_opened_at).toLocaleDateString()}
      </div>
    </button>
  );
}
