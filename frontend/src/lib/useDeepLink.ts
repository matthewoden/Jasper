/**
 * useDeepLink resolves ?note=<uuid> / ?path=<rel> at boot.
 *
 * Over REST, not WebSocket — WS may not be connected yet. ?note is preferred
 * because it survives renames.
 *
 * Gated on treeReady: hooks consuming activeNoteId assume a populated tree.
 *
 * Strips the params on success via replaceState, so a refresh does not
 * re-resolve and race the daily-note-on-boot setting.
 */

import { useEffect } from "react";
import { getNote, getNoteByPath } from "./notesApi";
import { usePaneStore } from "./usePaneStore";

export function useDeepLink(treeReady: boolean): void {
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
          const r = await getNote(id);
          if (r.data && typeof r.data.id === "string") {
            resolvedId = r.data.id;
          }
        } else if (path) {
          const r = await getNoteByPath(path);
          if (r.data && typeof r.data.id === "string") {
            resolvedId = r.data.id;
          }
        }

        if (!resolvedId) {
          navigateNotFound();
          return;
        }

        usePaneStore.getState().openInActivePane(resolvedId);
        cleanUrl();
      } catch {
        navigateNotFound();
      }
    })();
  }, [treeReady]);
}
