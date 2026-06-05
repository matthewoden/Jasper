/**
 * vaultApi — typed wrappers for the /vault/* routes (Plan 08-17c).
 *
 * Per CONTEXT.md API-03 / D-54: OpenAPI-first. Uses the existing `client`
 * singleton from api/client.ts which already attaches X-Session-ID middleware
 * and is typed against the generated schema.d.ts.
 *
 * The /vault/* routes were added to schema.d.ts by 08-17b's `make gen` step.
 *
 * SECURITY-06 (V-PARK-1): validateVaultPath runs BEFORE every network call.
 * The backend repeats these checks (defense in depth) — client-side is UX,
 * backend is security. See T-17c-01 in the threat model.
 */

import { client } from "../api/client";
import type { components } from "../api/schema";

export type RecentVaultEntry = components["schemas"]["RecentVaultEntry"];

export interface GetVaultRecentResponse {
  vaults: RecentVaultEntry[];
  banner: string;
}


export type PathValidationError = {
  ok: false;
  code: "not-abs" | "traversal" | "non-ascii" | "non-nfc" | "double-slash" | "empty";
  message: string;
};

export type PathValidationResult = { ok: true } | PathValidationError;

/**
 * validateVaultPath — 5-rule pipeline from 07-32a / D-44 / V-PARK-1.
 *
 * Rules:
 *   1. Non-empty
 *   2. Must start with "/" (absolute path)
 *   3. Must not contain ".." segments (traversal)
 *   4. Must not contain "//" (double slash)
 *   5. NFC-normalized (checked before ASCII to give actionable error for NFD paths)
 *   6. ASCII-only (charCode <= 0x7F) — V-PARK-1
 *
 * Exported so components and tests can use the pure validator without
 * triggering a fetch.
 */
export function validateVaultPath(path: string): PathValidationResult {
  if (!path) {
    return { ok: false, code: "empty", message: "Path is required." };
  }
  if (!path.startsWith("/")) {
    return {
      ok: false,
      code: "not-abs",
      message: "Path must be absolute (starts with /).",
    };
  }
  if (path.includes("..")) {
    return {
      ok: false,
      code: "traversal",
      message: "Path must not contain '..' segments.",
    };
  }
  if (path.includes("//")) {
    return {
      ok: false,
      code: "double-slash",
      message: "Path must not contain double slashes.",
    };
  }
  if (path.normalize("NFC") !== path) {
    return {
      ok: false,
      code: "non-nfc",
      message: "Path must be Unicode-NFC-normalized for cross-platform safety.",
    };
  }
  for (let i = 0; i < path.length; i++) {
    if (path.charCodeAt(i) > 0x7f) {
      return {
        ok: false,
        code: "non-ascii",
        message:
          "Path must be ASCII for cross-platform safety. Rename the folder or pick a different one.",
      };
    }
  }
  return { ok: true };
}


/**
 * vaultApi — typed wrappers calling /api/v1/vault/* via the shared openapi-fetch
 * client singleton (inherits X-Session-ID header middleware from api/client.ts).
 *
 * Path validation via validateVaultPath runs before every write call
 * (SECURITY-06 client-side gate). Backend repeats validation (defense in depth).
 */

export const vaultApi = {
  /**
   * GET /api/v1/vault/current
   * Returns the open vault's RecentVaultEntry, or null when no vault is open.
   *
   * Wire shape per openapi.yaml VaultCurrentResponse is `{ vault?: RecentVaultEntry | null }`
   * — the field is omitempty on the backend so an empty wrapper `{}` means "no vault open."
   * Unwrap `data.vault` (treating absence as null) so BootGate's `current === null`
   * check actually fires on first-run / wiped-state boots.
   */
  getCurrent: async (): Promise<RecentVaultEntry | null> => {
    const { data, error } = await client.GET("/vault/current");
    if (error) throw new Error("Failed to fetch current vault");
    const wrapper = data as { vault?: RecentVaultEntry | null } | null | undefined;
    return wrapper?.vault ?? null;
  },

  /**
   * GET /api/v1/vault/recent
   * Returns { vaults, banner }. Banner is non-empty when a V13/V14 condition
   * was detected at boot.
   */
  getRecent: async (): Promise<GetVaultRecentResponse> => {
    const { data, error } = await client.GET("/vault/recent");
    if (error) throw new Error("Failed to fetch recent vaults");
    const resp = data as { vaults?: RecentVaultEntry[]; banner?: string } | undefined;
    return {
      vaults: resp?.vaults ?? [],
      banner: resp?.banner ?? "",
    };
  },

  /**
   * POST /api/v1/vault/open
   * Opens an existing vault (must contain .jasper/).
   * Validates path locally before the network call (SECURITY-06).
   */
  open: async (path: string): Promise<RecentVaultEntry> => {
    const validation = validateVaultPath(path);
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    const { data, error } = await client.POST("/vault/open", {
      body: { path },
    });
    if (error) {
      const msg =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : "Failed to open vault";
      throw new Error(msg);
    }
    return data as RecentVaultEntry;
  },

  /**
   * POST /api/v1/vault/create
   * Creates a new vault in an empty folder, runs migrations, registers in
   * recent_vaults. Validates path locally before the network call (SECURITY-06).
   */
  create: async (req: {
    path: string;
    display_name?: string;
    theme: "dark" | "light";
    daily_template: string;
    mcp_enabled: boolean;
  }): Promise<RecentVaultEntry> => {
    const validation = validateVaultPath(req.path);
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    const { data, error } = await client.POST("/vault/create", {
      body: req,
    });
    if (error) {
      const msg =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : "Failed to create vault";
      throw new Error(msg);
    }
    return data as RecentVaultEntry;
  },

  /**
   * POST /api/v1/vault/switch
   * Hot-swaps from the currently open vault to the target vault path.
   * Returns the new vault's RecentVaultEntry on success.
   * Throws on 400 (bad path) or 409 (switch already in progress).
   * Validates path locally before the network call (SECURITY-06).
   */
  switch: async (path: string): Promise<RecentVaultEntry> => {
    const validation = validateVaultPath(path);
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    const { data, error, response } = await client.POST("/vault/switch", {
      body: { path },
    });
    if (response.status === 409) {
      const body = (await response.json()) as { current_target?: string };
      throw new Error(`Already switching to ${body.current_target ?? "unknown"}`);
    }
    if (error) {
      const msg =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : "Failed to switch vault";
      throw new Error(msg);
    }
    return data as RecentVaultEntry;
  },

  /**
   * POST /api/v1/vault/forget
   * Removes an entry from recent_vaults (idempotent, does NOT delete files).
   */
  forget: async (path: string): Promise<void> => {
    const { error } = await client.POST("/vault/forget", {
      body: { path },
    });
    if (error) {
      console.warn("[vaultApi.forget] error:", error);
    }
  },
};
