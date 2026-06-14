/**
 * useVaultPicker — Zustand-backed hook for vault picker state.
 *
 * Returns isOpen / open() / close() from the vaultPickerOpen slice in useTreeStore,
 * plus current, recents, banner, isLoading, and refresh() as transient local state.
 *
 * Boot detection (first-run vs switch) lives in App.tsx via a direct
 * vaultApi.getCurrent call — keeping the boot path independent of this hook.
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
