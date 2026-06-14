/**
 * registerVaultCommands — registers vault-related Cmd+P palette entries.
 *
 * The "Switch vault…" command opens the VaultPicker in switch mode.
 * Cmd-Shift-V keybind is intentionally absent — it collides with Chrome's
 * paste-plain-text shortcut.
 */

import { useTreeStore } from "../useTreeStore";

/** run() target for the "Switch vault…" palette command. */
export function switchVaultCommand(): void {
  useTreeStore.getState().setVaultPickerOpen(true);
}
