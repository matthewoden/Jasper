/**
 * useMigrationStatus — single-flight GET /admin/status on mount, plus a
 * manual refresh() called after a successful reindex.
 *
 * Shape { state, failedMigration, logsPath, notesIndexed, loading, error, refresh }
 * is the contract MigrationBanner depends on; do not change without sweeping
 * every call site.
 *
 * State defaults to "ok" until the first fetch resolves — the banner only
 * renders for state === "rolled_back", so the optimistic default avoids a flash.
 */

import { useCallback, useEffect, useState } from "react";

import { getAdminStatus } from "./adminApi";

export type MigrationState =
  | "ok"
  | "rolled_back"
  | "rebuilding"
  | "unrecoverable";

export interface UseMigrationStatusResult {
  state: MigrationState;
  failedMigration?: string;
  logsPath?: string;
  notesIndexed?: number;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

function extractErrorMessage(respErr: unknown): string {
  if (typeof respErr === "string") return respErr;
  if (respErr && typeof respErr === "object" && "message" in respErr) {
    const msg = (respErr as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return "status fetch failed";
}

export function useMigrationStatus(): UseMigrationStatusResult {
  const [state, setState] = useState<MigrationState>("ok");
  const [failedMigration, setFailed] = useState<string | undefined>();
  const [logsPath, setLogsPath] = useState<string | undefined>();
  const [notesIndexed, setNotesIndexed] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: respErr } = await getAdminStatus();
      if (respErr) {
        setError(new Error(extractErrorMessage(respErr)));
        return;
      }
      if (data) {
        setState(data.state as MigrationState);
        setFailed(data.failed_migration);
        setLogsPath(data.logs_path);
        setNotesIndexed(data.notes_indexed);
      }
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error: respErr } = await getAdminStatus();
        if (cancelled) return;
        if (respErr) {
          setError(new Error(extractErrorMessage(respErr)));
          setLoading(false);
          return;
        }
        if (data) {
          setState(data.state as MigrationState);
          setFailed(data.failed_migration);
          setLogsPath(data.logs_path);
          setNotesIndexed(data.notes_indexed);
        }
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    state,
    failedMigration,
    logsPath,
    notesIndexed,
    loading,
    error,
    refresh,
  };
}
