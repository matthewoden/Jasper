/**
 * VaultPickerRow — renders one RecentVaultEntry in the picker's Recent tab.
 *
 * V11: missing=true → row is greyed (opacity 0.6) with "Folder not found" caption
 * plus Reconnect and Remove action buttons.
 *
 * Plan 08-17c Task 2.
 */

import { vaultApi } from "../../lib/vaultApi";
import type { components } from "../../api/schema";

type RecentVaultEntry = components["schemas"]["RecentVaultEntry"];

export interface VaultPickerRowProps {
  entry: RecentVaultEntry;
  onReconnect: (path: string) => void;
  onForgotten: () => void;
}

export function VaultPickerRow({
  entry,
  onReconnect,
  onForgotten,
}: VaultPickerRowProps) {
  const handleOpen = async () => {
    await vaultApi.open(entry.path);
    window.location.reload();
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
