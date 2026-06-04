/**
 * useVaultPicker — Zustand-backed hook for vault picker state.
 *
 * Plan 08-17c (V7 / V11 / ADR-001 §3).
 *
 * Returns:
 *   - isOpen: boolean  (from vaultPickerOpen slice in useTreeStore)
 *   - open() / close(): toggle the picker modal
 *   - current: RecentVaultEntry | null
 *   - recents: RecentVaultEntry[]
 *   - banner: string (V13/V14 banner from GET /vault/recent)
 *   - isLoading: boolean
 *   - refresh(): re-fetches getCurrent + getRecent
 *
 * State management (D-55 ADD-only):
 *   - `isOpen` lives in the NEW `vaultPickerOpen` slice in useTreeStore.
 *   - `current`, `recents`, `banner`, `isLoading` are local React state
 *     (transient, not persisted — same pattern as other picker state in
 *     the store).
 *
 * Boot vs switch mode:
 *   - Boot detection lives in App.tsx via a direct vaultApi.getCurrent call
 *     (not this hook) — keeping the boot path simple.
 *   - This hook is used by: StatusBar.tsx (to show current vault + open picker)
 *     + VaultPicker.tsx itself + registerVaultCommands.ts.
 */

import { useEffect, useState } from "react";
import { useTreeStore } from "./useTreeStore";
import { vaultApi } from "./vaultApi";
import type { RecentVaultEntry } from "./vaultApi";

export interface UseVaultPickerResult {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  current: RecentVaultEntry | null;
  recents: RecentVaultEntry[];
  banner: string;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useVaultPicker(): UseVaultPickerResult {
  const isOpen = useTreeStore((s) => s.vaultPickerOpen);
  const setOpen = useTreeStore((s) => s.setVaultPickerOpen);

  const [current, setCurrent] = useState<RecentVaultEntry | null>(null);
  const [recents, setRecents] = useState<RecentVaultEntry[]>([]);
  const [banner, setBanner] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const refresh = async () => {
    setIsLoading(true);
    try {
      const [c, r] = await Promise.all([
        vaultApi.getCurrent(),
        vaultApi.getRecent(),
      ]);
      setCurrent(c);
      setRecents(r.vaults);
      setBanner(r.banner);
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch on mount — refresh is intentionally stable (closure over stable setters);
  // the empty dep array is correct (fetch once at mount, re-fetch via explicit refresh()).
  useEffect(() => {
    void refresh();
  }, []);

  return {
    isOpen,
    open: () => setOpen(true),
    close: () => setOpen(false),
    current,
    recents,
    banner,
    isLoading,
    refresh,
  };
}
