/**
 * Opens a vault-relative path in the host OS file manager, with a re-entrancy guard
 * so rapid double-clicks no-op while a reveal is in flight.
 *
 * Every reveal mount point shares this hook — one POST /reveal shape, one place
 * that decides the platform-appropriate toast.
 */
import { useCallback, useState } from "react";
import { useToast } from "../components/toast.utils";
import { revealPath, revealVaultRoot as revealVaultRootApi, type RevealResult } from "./revealApi";

export function useReveal() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  const showResultToast = useCallback(
    (result: RevealResult) => {
      if (result.ok) {
        const title =
          result.platform === "wsl2" ? "Opened in Explorer" : "Opened in Finder";
        toast({ title, variant: "info" });
        return;
      }

      if (result.status === 501) {
        toast({
          title: "Show in file manager isn't supported on Linux yet",
          description: result.errorMessage ?? "",
          variant: "error",
        });
        return;
      }

      toast({
        title: "Could not open file manager",
        description: result.errorMessage ?? "",
        variant: "error",
      });
    },
    [toast],
  );

  const reveal = useCallback(
    async (path: string) => {
      if (loading) return;

      setLoading(true);
      try {
        showResultToast(await revealPath(path));
      } finally {
        setLoading(false);
      }
    },
    [loading, showResultToast],
  );

  const revealVaultRoot = useCallback(async () => {
    if (loading) return;

    setLoading(true);
    try {
      showResultToast(await revealVaultRootApi());
    } finally {
      setLoading(false);
    }
  }, [loading, showResultToast]);

  return { reveal, revealVaultRoot, loading };
}
