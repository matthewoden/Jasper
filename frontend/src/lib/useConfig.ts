/**
 * useConfig — typed wrappers around GET /config, PUT /config, and
 * PATCH /config, plus a hook that keeps the loaded Config in state with
 * cancel-on-unmount safety. Two write channels: `saveConfig` sends a sparse
 * patch via PATCH (serialised server-side, WR-06); `replaceConfig` sends a
 * whole document via PUT, used only by per-section Reset.
 */
import { useEffect, useState, useCallback, useRef } from "react";
import { client } from "../api/client";
import type { components } from "../api/schema";

export type Config = components["schemas"]["Config"];
export type ConfigPatch = components["schemas"]["ConfigPatch"];
export type ApiError = { code: string; message: string; status: number };

// Mirrors the server's deepMergeRawMaps: a key present in the patch always
// applies (including "", 0, false); a key absent from the patch leaves
// base's value untouched. Recurses only where both sides are plain objects,
// so a nested-but-sparse patch (e.g. { editor: { fontSize: 18 } }) doesn't
// blow away sibling fields on the base's nested object.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mergeObj(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    const patchVal = patch[key];
    const baseVal = result[key];
    result[key] =
      isPlainObject(baseVal) && isPlainObject(patchVal) ? mergeObj(baseVal, patchVal) : patchVal;
  }
  return result;
}

function mergePatch(base: Config, patch: ConfigPatch): Config {
  return mergeObj(
    base as unknown as Record<string, unknown>,
    patch as unknown as Record<string, unknown>,
  ) as unknown as Config;
}

function asApiError(error: unknown, status: number): ApiError {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const e = error as { code: unknown; message: unknown };
    return {
      code: typeof e.code === "string" ? e.code : "unknown",
      message: typeof e.message === "string" ? e.message : "request failed",
      status,
    };
  }
  return { code: "unknown", message: "request failed", status };
}

export async function getConfig(): Promise<{ data?: Config; error?: ApiError }> {
  const res = await client.GET("/config");
  if (!res.data) {
    const status = (res.response as { status?: number } | undefined)?.status ?? 0;
    return { error: asApiError(res.error, status) };
  }
  return { data: res.data };
}

export async function putConfig(c: Config): Promise<{ data?: Config; error?: ApiError }> {
  const res = await client.PUT("/config", { body: c });
  if (!res.data) {
    const status = (res.response as { status?: number } | undefined)?.status ?? 0;
    return { error: asApiError(res.error, status) };
  }
  return { data: res.data };
}

export async function patchConfig(p: ConfigPatch): Promise<{ data?: Config; error?: ApiError }> {
  const res = await client.PATCH("/config", { body: p });
  if (!res.data) {
    const status = (res.response as { status?: number } | undefined)?.status ?? 0;
    return { error: asApiError(res.error, status) };
  }
  return { data: res.data };
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
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  // Track the last server-confirmed config so that saveConfig rollback
  // always restores the true persisted value, not an optimistic intermediate.
  // A closure over `config` would capture the optimistic value; a ref updated
  // in a separate effect always holds the last committed state.
  const persistedConfigRef = useRef<Config | null>(null);
  useEffect(() => {
    persistedConfigRef.current = config;
  }, [config]);

  useEffect(() => {
    let cancelled = false;
    getConfig().then(({ data, error: err }) => {
      if (cancelled) return;
      if (data) setConfig(data);
      if (err) setError(err);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // saveConfig reads the rollback value from the ref, not a closure, so
  // concurrent calls roll back to the last persisted state. The optimistic
  // frame is the sparse patch merged into the last persisted config (not the
  // patch alone) — this mirrors the server's own merge semantics, so the
  // local frame and the eventual server echo agree, and rollback on error
  // reverts the merged frame back to the last persisted document (merge-
  // then-revert), never a per-field diff.
  const saveConfig = useCallback(async (patch: ConfigPatch) => {
    const prev = persistedConfigRef.current;
    if (prev) setConfig(mergePatch(prev, patch));
    const { data, error: err } = await patchConfig(patch);
    if (err) {
      setConfig(prev);
      setError(err);
      return { error: err };
    }
    if (data) {
      setConfig(data);
      persistedConfigRef.current = data;
    }
    return {};
  }, []);

  // replaceConfig (D-07): per-section Reset needs a whole-document write
  // (PUT), but the rebase must happen in here, where persistedConfigRef is
  // available — not at the call site, where only a stale closure over
  // `config` exists. Reading the freshest persisted document at call time is
  // what stops Reset from clobbering a save that landed after the caller's
  // last render.
  const replaceConfig = useCallback(async (patch: ConfigPatch) => {
    const prev = persistedConfigRef.current;
    if (!prev) return {};
    const next = mergePatch(prev, patch);
    setConfig(next);
    const { data, error: err } = await putConfig(next);
    if (err) {
      setConfig(prev);
      setError(err);
      return { error: err };
    }
    if (data) {
      setConfig(data);
      persistedConfigRef.current = data;
    }
    return {};
  }, []);

  return { config, error, saveConfig, replaceConfig };
}
