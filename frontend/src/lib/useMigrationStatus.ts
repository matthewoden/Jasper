/**
 * useMigrationStatus — reads the shared cached /admin/status resource
 * (cached, invalidated by reindex:complete).
 *
 * Shape { state, failedMigration, logsPath, notesIndexed, loading, error, refresh }
 * is the contract MigrationBanner depends on; do not change without sweeping
 * every call site.
 *
 * State defaults to "ok" until the first fetch resolves — the banner only
 * renders for state === "rolled_back", so the optimistic default avoids a flash.
 */

import { useCallback } from "react";

import { adminStatusResource } from "./adminApi";
import { useResource } from "./resources";

export type MigrationState =
  | "ok"
  | "rolled_back"
  | "rebuilding"
  | "unrecoverable";

export interface McpStatus {
  up: boolean;
  reason?: string;
}

export interface UseMigrationStatusResult {
  state: MigrationState;
  failedMigration?: string;
  logsPath?: string;
  notesIndexed?: number;
  mcp?: McpStatus;
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
  const snapshot = useResource(adminStatusResource);
  const resp = snapshot.data;

  let state: MigrationState = "ok";
  let failedMigration: string | undefined;
  let logsPath: string | undefined;
  let notesIndexed: number | undefined;
  let mcp: McpStatus | undefined;
  let respError: Error | null = null;

  if (resp) {
    const { data: statusData, error: statusError } = resp;
    if (statusData) {
      state = statusData.state as MigrationState;
      failedMigration = statusData.failed_migration;
      logsPath = statusData.logs_path;
      notesIndexed = statusData.notes_indexed;
      mcp = statusData.mcp;
    }
    if (statusError) {
      respError = new Error(extractErrorMessage(statusError));
    }
  }

  const error = respError ?? snapshot.error;

  const refresh = useCallback(async () => {
    await adminStatusResource.invalidate();
  }, []);

  return {
    state,
    failedMigration,
    logsPath,
    notesIndexed,
    mcp,
    loading: snapshot.loading,
    error,
    refresh,
  };
}
