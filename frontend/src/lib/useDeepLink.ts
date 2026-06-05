/**
 * useDeepLink — SHARE-02 deep-link boot handler (Phase 8 Plan 08-07).
 *
 * Reads `?note=<uuid>` or `?path=<rel>` from window.location at mount
 * and resolves the target via REST (NOT WebSocket — WS may not be
 * connected at boot time; per CONTEXT.md §Bug-adjacent "Deep-link race
 * with WS hydration").
 *
 *   D-30: prefer ?note=<uuid> (rename-resilient); ?path=<rel> is the
 *         fallback.
 *   D-31: focus the resolved note via setActiveNote (existing-tab focus
 *         is the same as opening a tab in a single-user SPA).
 *   D-32: on miss → window.location.assign('/note-not-found?query=<raw>')
 *         so the user sees the friendly view (handled by main.tsx route
 *         dispatch, Plan 08-07 Task 3).
 *
 * Pitfall 6 mitigation: gates on `treeReady` so setActiveNote runs
 * AFTER the initial GET /tree fetch resolves. The active note hooks
 * (EditorPane, breadcrumbs, sidebar selection) all assume the tree
 * is populated when they read activeNoteId.
 *
 * URL hygiene: on successful resolve, the `?note=` / `?path=` params
 * are stripped via history.replaceState so a refresh doesn't re-resolve
 * (which would race the daily-note-on-boot setting if both are active).
 *
 * SECURITY (T-08-27 / T-08-30): the path string is sent to the backend
 * which re-validates with the 5-rule pipeline. The frontend does not
 * trust the param.
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
