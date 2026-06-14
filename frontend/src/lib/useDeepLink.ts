/**
 * useDeepLink — boot handler for ?note=<uuid> / ?path=<rel> deep links.
 *
 * Resolves via REST rather than WebSocket because WS may not be connected
 * at boot time. Prefers ?note=<uuid> (rename-resilient) over ?path=<rel>.
 *
 * Gates on `treeReady` so setActiveNote runs after GET /tree resolves —
 * hooks that consume activeNoteId assume the tree is populated.
 *
 * On successful resolve, strips the params via history.replaceState so a
 * refresh doesn't re-resolve and race the daily-note-on-boot setting.
 *
 * Security: the path string is sent to the backend for re-validation;
 * the frontend does not trust the param value.
 */

import { useEffect } from "react";
import { client } from "../api/client";
import { useTreeStore } from "./useTreeStore";

export function useDeepLink(treeReady: boolean): void {
  const setActiveNote = useTreeStore((s) => s.setActiveNote);

  useEffect(() => {
    if (!treeReady) return;

    const url = new URL(window.location.href);
    const id = url.searchParams.get("note");
    const path = url.searchParams.get("path");
    if (!id && !path) return;

    const queryRaw = id ?? path ?? "";

    const cleanUrl = (): void => {
      url.searchParams.delete("note");
      url.searchParams.delete("path");
      window.history.replaceState({}, "", url.toString());
    };

    const navigateNotFound = (): void => {
      window.location.assign(
        `/note-not-found?query=${encodeURIComponent(queryRaw)}`,
      );
    };

    (async () => {
      try {
        let resolvedId: string | null = null;

        if (id) {
          const r = await client.GET("/notes/{id}", {
            params: { path: { id } },
          });
          if (r.data && typeof r.data.id === "string") {
            resolvedId = r.data.id;
          }
        } else if (path) {
          const r = await client.GET("/notes/by-path", {
            params: { query: { path } },
          });
          if (r.data && typeof r.data.id === "string") {
            resolvedId = r.data.id;
          }
        }

        if (!resolvedId) {
          navigateNotFound();
          return;
        }

        setActiveNote(resolvedId);
        cleanUrl();
      } catch {
        navigateNotFound();
      }
    })();
  }, [treeReady, setActiveNote]);
}
