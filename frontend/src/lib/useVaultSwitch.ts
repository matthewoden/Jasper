/**
 * useVaultSwitch — Plan 08-17d (V4).
 *
 * Provides the vault-switch overlay state and the `markSwitching` /
 * `markSwitched` callbacks that are invoked by useSessionSync's vault
 * event handlers.
 *
 * State lives in useTreeStore's `vaultSwitching` slice (ADD-only per
 * D-55 invariant). The slice is transient — it is never persisted to
 * localStorage. Clearing happens automatically on window.location.reload().
 *
 * V4 10-second failsafe: when `markSwitching` fires it schedules a
 * `setTimeout(() => window.location.reload(), 10000)` so the SPA
 * never stays stuck on the overlay indefinitely if the vault.switched
 * WS event is missed (e.g. the WS connection drops during teardown).
 */

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
     * markSwitching — called by useSessionSync on vault.switching event.
     * Sets the overlay state and schedules the V4 10-second failsafe reload.
     */
    markSwitching: (name: string) => {
      // R4-13 (Plan 08-22): clear the active-note state BEFORE mounting
      // the overlay. Two effects:
      //   1. EditorPane's load effect re-runs with noteId=null, which
      //      runs the AbortController cleanup on the in-flight
      //      getNote(<prior-vault-uuid>) call. The server response is
      //      never delivered → no 404 flash.
      //   2. The debounced LS subscriber clears
      //      `jasper.tree.activeNoteId` within 250ms so a post-reload
      //      hydration in vault B does NOT refetch vault A's note.
      //
      // setActiveFilePath(null) handles the file-preview reciprocal so
      // a non-markdown file open in vault A doesn't survive into B.
      useTreeStore.getState().setActiveNote(null);
      useTreeStore.getState().setActiveFilePath(null);

      setSwitching({ active: true, targetName: name });
      // V4: 10-second client-side failsafe — reload even if vault.switched
      // WS event never arrives (e.g. WS drops during server teardown).
      setTimeout(() => {
        window.location.reload();
      }, 10000);
    },
    /**
     * markSwitched — called by useSessionSync on vault.switched event.
     * Triggers the SPA reload so clients reconnect to the new vault's hub.
     */
    markSwitched: () => {
      window.location.reload();
    },
  };
}
