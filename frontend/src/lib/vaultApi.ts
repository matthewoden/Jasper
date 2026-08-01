/**
 * vaultApi — typed wrappers for the /vault/* routes.
 *
 * Uses the shared `client` singleton (api/client.ts) which attaches X-Session-ID
 * middleware and is typed against the generated schema.d.ts.
 *
 * validateVaultPath runs before every write call (client-side UX gate).
 * The backend repeats all checks for defense in depth.
 */

import { client } from "../api/client";
import type { components } from "../api/schema";
import { createResource } from "./resources";

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
 * validateVaultPath — 6-rule validation pipeline for vault paths.
 *
 * Rules (in order):
 *   1. Non-empty
 *   2. Must start with "/" (absolute path)
 *   3. Must not contain ".." segments (traversal)
 *   4. Must not contain "//" (double slash)
 *   5. NFC-normalized (checked before ASCII to give actionable error for NFD paths)
 *   6. ASCII-only (charCode <= 0x7F) — required for cross-platform safety
 *
 * Exported so components and tests can use the pure validator without triggering a fetch.
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


async function fetchCurrentVault(): Promise<RecentVaultEntry | null> {
  const { data, error } = await client.GET("/vault/current");
  if (error) throw new Error("Failed to fetch current vault");
  const wrapper = data as { vault?: RecentVaultEntry | null } | null | undefined;
  return wrapper?.vault ?? null;
}

async function fetchRecentVaults(): Promise<GetVaultRecentResponse> {
  const { data, error } = await client.GET("/vault/recent");
  if (error) throw new Error("Failed to fetch recent vaults");
  const resp = data as { vaults?: RecentVaultEntry[]; banner?: string } | undefined;
  return {
    vaults: resp?.vaults ?? [],
    banner: resp?.banner ?? "",
  };
}

// pass-through, not cached: both change on vault open/create/remove with no
// WS event to invalidate on, and useVaultPicker.refresh() already re-reads
// them imperatively after every such mutation (D-15 as amended). Still
// coalesced — concurrent callers for the same endpoint collapse into one
// client.GET.
const vaultCurrentResource = createResource("vaultCurrent", fetchCurrentVault, {
  mode: "pass-through",
});
const vaultRecentResource = createResource("vaultRecent", fetchRecentVaults, {
  mode: "pass-through",
});

/**
 * vaultApi — typed wrappers for /api/v1/vault/* via the shared openapi-fetch
 * client singleton (inherits X-Session-ID middleware).
 */

export const vaultApi = {
  /**
   * GET /api/v1/vault/current — returns the open vault's entry, or null when no vault is open.
   *
   * The backend response is `{ vault?: RecentVaultEntry | null }` (omitempty), so an empty
   * wrapper `{}` means "no vault open." Unwraps data.vault so callers get null on first-run.
   */
  getCurrent: (): Promise<RecentVaultEntry | null> => vaultCurrentResource.read(),

  /**
   * GET /api/v1/vault/recent — returns { vaults, banner }.
   * Banner is non-empty when a previous-vault-missing condition was detected at boot.
   */
  getRecent: (): Promise<GetVaultRecentResponse> => vaultRecentResource.read(),

  /**
   * POST /api/v1/vault/open — opens an existing vault (must contain .jasper/).
   * Validates path before the network call.
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
   * POST /api/v1/vault/create — creates a new vault in an empty folder,
   * runs migrations, and registers it in recent_vaults. Validates path before the network call.
   */
  create: async (req: {
    path: string;
    display_name?: string;
    theme: "dark" | "light";
    daily_template: string;
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
   * POST /api/v1/vault/switch — hot-swaps to the target vault path.
   * Throws on 400 (bad path) or 409 (switch already in progress).
   * Validates path before the network call.
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
   * POST /api/v1/vault/forget — removes an entry from recent_vaults (idempotent, no file deletion).
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
