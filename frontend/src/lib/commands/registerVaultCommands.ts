/**
 * registerVaultCommands — registers vault-related Cmd+P palette entries.
 *
 * The "Switch vault…" command opens the VaultPicker in switch mode.
 * No dedicated keyboard shortcut is registered for vault switching.
 * Use Cmd+P → "Switch vault…" or click the vault name in the status bar.
 */

import { useTreeStore } from "../useTreeStore";

/** run() target for the "Switch vault…" palette command. */
export function switchVaultCommand(): void {
  useTreeStore.getState().setVaultPickerOpen(true);
}
