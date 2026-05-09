/**
 * useConfig — typed openapi-fetch wrapper around GET /config + PUT /config
 * (Plan 05-03). Phase 5 D-13.
 *
 * Pattern mirrors treeApi.ts (small typed wrapper) + useFileTree.ts
 * (hook with cancel-on-unmount). Phase 5 only consumes from the
 * useTheme hook; future phases (UX-V2-01 settings panel) consume too.
 */
import { useEffect, useState, useCallback } from "react";
import { client } from "../api/client";
import type { components } from "../api/schema";

export type Config = components["schemas"]["Config"];
export type ApiError = { code: string; message: string; status: number };

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
  // openapi-typescript types /config as having no error responses, so
  // `res.error` is typed as `never` — use a runtime guard instead.
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

/**
 * useConfig — hook returning the loaded Config + a saveConfig setter.
 * Returns { config: null, ... } until GET /config completes.
 */
export function useConfig(): {
  config: Config | null;
  error: ApiError | null;
  saveConfig: (next: Config) => Promise<{ error?: ApiError }>;
} {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

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

  const saveConfig = useCallback(async (next: Config) => {
    setConfig(next); // optimistic
    const { data, error: err } = await putConfig(next);
    if (err) {
      setError(err);
      return { error: err };
    }
    if (data) setConfig(data); // server may have echoed back exactly next
    return {};
  }, []);

  return { config, error, saveConfig };
}
