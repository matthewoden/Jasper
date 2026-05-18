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
import { useToast } from "../components/Toast";
import { revealPath } from "./revealApi";

export function useReveal() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  const reveal = useCallback(
    async (path: string) => {
      // Re-entrancy guard (mirrors useDailyNote's T-7-26 pattern). Double-click
      // on a tree row's "Show in file manager" should not fire two reveals.
      if (loading) return;

      setLoading(true);
      try {
        const result = await revealPath(path);

        if (result.ok) {
          // LOCKED copy (08-UI-SPEC §Copywriting):
          //   darwin → "Opened in Finder"
          //   wsl2   → "Opened in Explorer"
          // Description omitted per UI-SPEC (single-line toast on success).
          const title =
            result.platform === "wsl2" ? "Opened in Explorer" : "Opened in Finder";
          toast({ title, variant: "info" });
          return;
        }

        // 501 from native Linux gets its own dedicated copy — backend's
        // message already contains "The file is at {abs_path}." so the
        // user can copy the path manually (T-08-26 accepted disclosure).
        if (result.status === 501) {
          toast({
            title: "Show in file manager isn't supported on Linux yet",
            description: result.errorMessage ?? "",
            variant: "error",
          });
          return;
        }

        // Generic non-2xx — 4xx invalid_path, 5xx exec_failed, etc.
        // The backend message is plain text (T-08-25 mitigation: no HTML
        // rendering anywhere — Toast.tsx uses React children-escape).
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
