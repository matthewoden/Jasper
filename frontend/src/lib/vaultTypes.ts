/**
 * vaultTypes — re-exports from generated schema.d.ts for convenience.
 *
 * Plan 08-17c: these were initially stubs; now 08-17b's make gen has
 * produced the real types in schema.d.ts. Both vaultApi.ts and
 * useVaultPicker.ts import directly from vaultApi.ts or this module.
 */


export type { RecentVaultEntry, GetVaultRecentResponse } from "./vaultApi";
