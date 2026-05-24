/**
 * vaultCopy — locked copy strings for the VaultPicker UI (Plan 08-17c).
 *
 * These constants enforce verbatim reuse of the 08-16 polish strings across
 * both VaultCreatePane and the existing SetupApp (D-58 no-copy-drift rule).
 *
 * DO NOT modify these strings without updating BOTH VaultCreatePane and
 * SetupApp tests that assert on the exact copy.
 *
 * Source:
 *   - TIER_1_LABEL / TIER_2_LABEL: 08-16 N8 (MCP grant tier copy)
 *   - DAILY_TEMPLATE_REQUIRED_LABEL: 08-16 N3 (REQUIRED eyebrow)
 *   - DAILY_TEMPLATE_HELP: 08-16 N3 ({{date}} token help text)
 */

/** 08-16 N8 — Tier 1 grant label (verbatim) */
export const TIER_1_LABEL = "Edit only (create + update)";

/** 08-16 N8 — Tier 2 grant label (verbatim) */
export const TIER_2_LABEL = "Full (create + update + move + delete)";

/** 08-16 N3 — REQUIRED eyebrow for daily template (verbatim) */
export const DAILY_TEMPLATE_REQUIRED_LABEL = "REQUIRED";

/** 08-16 N3 — {{date}} token help text (verbatim) */
export const DAILY_TEMPLATE_HELP = "Use {{date}} for today's date in YYYY-MM-DD";
