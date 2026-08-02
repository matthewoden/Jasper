/**
 * The single network surface for config operations. Components use
 * useConfig() (the hook); nothing outside this file and useConfig.ts calls
 * client.GET/PUT/PATCH("/config", ...) directly.
 */
import { client } from "../api/client";
import type { components } from "../api/schema";
import { createResource } from "./resources";

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

export function mergePatch(base: Config, patch: ConfigPatch): Config {
  return mergeObj(
    base as unknown as Record<string, unknown>,
    patch as unknown as Record<string, unknown>,
  ) as unknown as Config;
}

export function asApiError(error: unknown, status: number): ApiError {
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

function throwApiError(error: unknown, status: number): never {
  // Object.assign onto a real Error (not a plain {code,message,status}
  // object) so createResource's catch path — `err instanceof Error ? err :
  // new Error(String(err))` — preserves this instance untouched instead of
  // flattening it into a stringified message.
  throw Object.assign(new Error(asApiError(error, status).message), asApiError(error, status));
}

// Holds ONLY server-confirmed config: assigned from a GET/PATCH/PUT
// response, never from an optimistic frame. This is persistedConfigRef
// promoted to module scope now that every useConfig() instance shares one
// cache — mirroring every `config` transition would also capture the
// optimistic frame a save sets before its request resolves, which makes it
// the base for the next concurrent save and the rollback target for a
// failed one, so a failing save could revert a sibling save that already
// succeeded.
let lastPersisted: Config | null = null;

export function getLastPersisted(): Config | null {
  return lastPersisted;
}

async function getConfig(): Promise<Config> {
  const res = await client.GET("/config");
  if (!res.data) {
    const status = (res.response as { status?: number } | undefined)?.status ?? 0;
    throwApiError(res.error, status);
  }
  lastPersisted = res.data;
  return res.data;
}

// The boot-scoped classification for /config: there is no
// WebSocket event for config changes — phase32.1-uat.spec.ts's own header
// records that config edits are never pushed to other sessions — so there
// is nothing to put in invalidatedBy. The only in-session mutation path is
// this tab's own PATCH/PUT below, which useConfig.ts patches into this
// resource's cache directly via mutate(). Cross-session config staleness
// is a pre-existing accepted property, not something this phase introduces.
export const configResource = createResource("config", getConfig, {
  mode: "boot-scoped",
});

export async function putConfig(c: Config): Promise<{ data?: Config; error?: ApiError }> {
  const res = await client.PUT("/config", { body: c });
  if (!res.data) {
    const status = (res.response as { status?: number } | undefined)?.status ?? 0;
    return { error: asApiError(res.error, status) };
  }
  lastPersisted = res.data;
  return { data: res.data };
}

export async function patchConfig(p: ConfigPatch): Promise<{ data?: Config; error?: ApiError }> {
  const res = await client.PATCH("/config", { body: p });
  if (!res.data) {
    const status = (res.response as { status?: number } | undefined)?.status ?? 0;
    return { error: asApiError(res.error, status) };
  }
  lastPersisted = res.data;
  return { data: res.data };
}

// lastPersisted is module scope, matching every other __testing__ export in
// this codebase (createResource.ts, eventBus.ts, useFileTree.ts, ...) — a
// test that patches config needs a way to reset it between cases.
export const __testing__ = {
  reset(): void {
    lastPersisted = null;
  },
};
