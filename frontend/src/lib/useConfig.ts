/**
 * useConfig reads the boot-scoped config resource — fetched once per session.
 * Writes go through configResource.mutate so every mounted instance shares one
 * optimistic frame and one rollback target.
 *
 * saveConfig PATCHes a sparse patch; replaceConfig PUTs a whole document and is
 * used only by per-section Reset.
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

  // The optimistic frame merges the patch into the last persisted config, not
  // the patch alone, mirroring the server's merge so the local frame and the
  // eventual echo agree.
  //
  // These resolve with { error } and never reject, so the primitive's own
  // rollback (which needs a rejection) cannot fire. commit re-reads
  // getLastPersisted() instead — identical result, and a sibling save that
  // confirmed mid-flight is never discarded.
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

  // replaceConfig: per-section Reset needs a whole-document write
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
