/**
 * useVaultSwitch — vault-switch overlay state and callbacks for useSessionSync.
 *
 * State lives in useTreeStore's vaultSwitching slice (transient, never persisted;
 * cleared automatically on reload).
 *
 * markSwitching schedules a 10-second failsafe reload so the SPA never stays
 * stuck on the overlay if the vault.switched WS event is missed (e.g. the WS
 * connection drops during teardown).
 */

import { clearAllResources } from "./resources";
import { useTabStore } from "./useTabStore";
import { useTreeStore } from "./useTreeStore";

export function useVaultSwitch() {
  const switching = useTreeStore((s) => s.vaultSwitching);
  const setSwitching = useTreeStore((s) => s.setVaultSwitching);

  return {
    /** true while the vault-switch overlay should be visible */
    switching: switching.active,
    /** display_name of the target vault (shown in the overlay message) */
    targetName: switching.targetName,
    /**
     * markSwitching — called by useSessionSync on vault.switching.
     * Sets overlay state and schedules the 10-second failsafe reload.
     */
    markSwitching: (name: string) => {
      useTreeStore.getState().setActiveNote(null);
      useTreeStore.getState().setActiveFilePath(null);
      // Drop this vault's tabs before the reload so the new vault's session
      // never inherits cross-vault tabs (TAB-10).
      useTabStore.getState().clearAllTabs();
      // Every cached entry in the resource layer (tags, grants, bookmarks,
      // backlinks, workspace, config, vault-about) describes the OUTGOING
      // vault — clearing tabs without also clearing the cache would let the
      // swapped-in vault render the previous vault's data during the
      // window before the reload.
      clearAllResources();

      setSwitching({ active: true, targetName: name });
      setTimeout(() => {
        window.location.reload();
      }, 10000);
    },
    /**
     * markSwitched — called by useSessionSync on vault.switched.
     * Reloads the SPA so it reconnects to the new vault's hub.
     */
    markSwitched: () => {
      // A reload can be blocked or delayed (onbeforeunload, a slow paint),
      // and markSwitching's failsafe window is 10 seconds — clear again
      // here so the cache stays empty for the whole window, not just at
      // its start.
      clearAllResources();
      window.location.reload();
    },
  };
}
