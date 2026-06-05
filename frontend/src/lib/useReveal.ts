/**
 * useReveal — hook that opens a vault-relative path in the host OS file manager.
 *
 * Wraps revealPath() from revealApi with:
 *   - Re-entrancy guard: rapid double-clicks no-op while a reveal is in flight
 *   - Toast feedback (LOCKED copy from 08-UI-SPEC §Copywriting "Show in file manager Reveal"):
 *       - macOS success → title "Opened in Finder", variant info
 *       - WSL2 success  → title "Opened in Explorer", variant info
 *       - Linux 501     → title "Show in file manager isn't supported on Linux yet"
 *                          description = backend's "The file is at {abs_path}." (T-08-26 accepted)
 *       - Other failure → title "Could not open file manager", description = server message
 *
 * Used by the four reveal mount points (D-26):
 *   - TreeRowMenu (note/folder/file rows) — wired via TreeRow.onReveal
 *   - Breadcrumbs (folder-segment context menu)
 *   - CommandMenu palette ("Share" group)
 *
 * All 4 mount points share THIS hook — there is exactly one POST /reveal call
 * shape, and exactly one place that decides the toast.
 *
 * Returns { reveal(path), loading } for the caller.
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
