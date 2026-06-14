/**
 * useConfig — typed wrappers around GET /config + PUT /config and a hook
 * that keeps the loaded Config in state with cancel-on-unmount safety.
 */
import { useEffect, useState, useCallback, useRef } from "react";
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
  // concurrent calls roll back to the last persisted state.
  const saveConfig = useCallback(async (next: Config) => {
    const prev = persistedConfigRef.current;
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

  return { config, error, saveConfig };
}
