/**
 * registerVaultCommands — registers vault-related Cmd+P palette entries.
 *
 * V7 (Plan 08-17c): The "Switch vault…" command opens the VaultPicker in
 * switch mode by toggling the useTreeStore.vaultPickerOpen slice.
 *
 * IMPORTANT: Cmd-Shift-V hotkey is DROPPED (Chrome paste-plain-text collision).
 * hotkey: null is intentional — do not add a keybind here.
 *
 * Call site: invoke from App.tsx's commandActions useMemo (alongside the
 * existing share-reveal-current-note registration pattern).
 */

import { useTreeStore } from "../useTreeStore";

/**
 * Opens the vault picker modal by setting vaultPickerOpen=true in the store.
 * This is the run() target for the "Switch vault…" palette command.
 */
export function switchVaultCommand(): void {
  useTreeStore.getState().setVaultPickerOpen(true);
}
