/**
 * useReveal — hook that opens a vault-relative path in the host OS file manager.
 *
 * Wraps revealPath() with a re-entrancy guard (rapid double-clicks no-op while
 * a reveal is in flight) and platform-aware toast feedback:
 *   - macOS success → "Opened in Finder"
 *   - WSL2 success  → "Opened in Explorer"
 *   - Linux 501     → unsupported message + backend's absolute path hint
 *   - Other failure → "Could not open file manager" + server message
 *
 * All reveal mount points (TreeRowMenu, Breadcrumbs, CommandMenu) share this
 * hook — one POST /reveal shape, one place that decides the toast.
 */

import { useCallback, useState } from "react";
import { useToast } from "../components/toast.utils";
import { revealPath } from "./revealApi";

export function useReveal() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  const reveal = useCallback(
    async (path: string) => {
      if (loading) return;

      setLoading(true);
      try {
        const result = await revealPath(path);

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
      } finally {
        setLoading(false);
      }
    },
    [loading, toast],
  );

  return { reveal, loading };
}
