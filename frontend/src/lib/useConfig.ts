/**
 * useConfig — thin hook over configApi's shared, boot-scoped resource
 * (D-15: fetched once per session, no per-mount GET /config). Reads are a
 * useResource() render-time snapshot; writes go through
 * configResource.mutate() so every mounted instance's optimistic frame and
 * rollback target the same cache entry. Two write channels: `saveConfig`
 * sends a sparse patch via PATCH (serialised server-side, WR-06);
 * `replaceConfig` sends a whole document via PUT, used only by per-section
 * Reset.
 */
import { useCallback } from "react";
import { useResource } from "./resources";
import {
  configResource,
  getLastPersisted,
  mergePatch,
  patchConfig,
  putConfig,
} from "./configApi";
import type { ApiError, Config, ConfigPatch } from "./configApi";

export type { ApiError, Config, ConfigPatch } from "./configApi";

function toApiError(err: Error | null): ApiError | null {
  if (!err) return null;
  const e = err as Error & Partial<ApiError>;
  return {
    code: typeof e.code === "string" ? e.code : "unknown",
    message: e.message,
    status: typeof e.status === "number" ? e.status : 0,
  };
}

/**
 * useConfig — hook returning the loaded Config, a partial-write setter
 * (`saveConfig`, PATCH), and a whole-document setter (`replaceConfig`, PUT,
 * used only by per-section Reset). Returns { config: null, ... } until
 * GET /config completes.
 */
export function useConfig(): {
  config: Config | null;
  error: ApiError | null;
  saveConfig: (patch: ConfigPatch) => Promise<{ error?: ApiError }>;
  replaceConfig: (patch: ConfigPatch) => Promise<{ error?: ApiError }>;
} {
  const snapshot = useResource(configResource);
  const config = snapshot.data ?? null;
  const error = toApiError(snapshot.error);

  // The optimistic frame is the sparse patch merged into the last persisted
  // config (not the patch alone) — this mirrors the server's own merge
  // semantics, so the local frame and the eventual server echo agree.
  //
  // patchConfig/putConfig resolve with { error }, they never reject
  // (openapi-fetch never throws on an HTTP error response) — so a failure
  // can't rely on the primitive's own rollback path, which only fires on a
  // REJECTED request(). `commit` re-reads getLastPersisted() on failure
  // instead, producing the identical observable result: a sibling save that
  // confirmed while this one was in flight is never discarded, because a
  // failed write never landed server-side and the newest confirmed document
  // is already the correct post-failure state.
  const saveConfig = useCallback(async (patch: ConfigPatch) => {
    const result = await configResource.mutate<{ data?: Config; error?: ApiError }>({
      optimistic: (current) => {
        const base = getLastPersisted();
        return base ? mergePatch(base, patch) : (current as Config);
      },
      request: () => patchConfig(patch),
      commit: (_live, res) =>
        res.error ? (getLastPersisted() as Config) : (res.data as Config),
      rollback: () => getLastPersisted() as Config,
    });
    if (result.error) return { error: result.error };
    return {};
  }, []);

  // replaceConfig (D-07): per-section Reset needs a whole-document write
  // (PUT), rebased on the freshest persisted document at call time — not a
  // stale closure — so Reset can never clobber a save that landed after the
  // caller's last render.
  const replaceConfig = useCallback(async (patch: ConfigPatch) => {
    const base = getLastPersisted();
    if (!base) return {};
    const next = mergePatch(base, patch);
    const result = await configResource.mutate<{ data?: Config; error?: ApiError }>({
      optimistic: () => next,
      request: () => putConfig(next),
      commit: (_live, res) =>
        res.error ? (getLastPersisted() as Config) : (res.data as Config),
      rollback: () => getLastPersisted() as Config,
    });
    if (result.error) return { error: result.error };
    return {};
  }, []);

  return { config, error, saveConfig, replaceConfig };
}
