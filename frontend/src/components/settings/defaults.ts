/**
 * DEFAULT_CONFIG — frontend mirror of `backend/internal/config/defaults.go`'s
 * `Defaults()`, scoped to the fields a per-pane Reset (D-12) is allowed to
 * write. `server.port`, `server.dataDir`, and `mcp.port` are deliberately
 * omitted — a Reset must never rewrite the listening port or data directory.
 *
 * TypeScript cannot see the Go source, so there is no compile-time link
 * between the two. The pairing is verified end-to-end by the phase-32 E2E
 * Reset assertions (plan 32-11), which compare a fresh vault's `GET /config`
 * against these values.
 */
import type { Config } from "../../lib/useConfig";

export type DefaultConfigShape = {
  appName: Config["appName"];
  theme: Config["theme"];
  accent: Config["accent"];
  readingFont: Config["readingFont"];
  dailyNotes: Config["dailyNotes"];
  editor: Config["editor"];
  templates: NonNullable<Config["templates"]>;
  mcp: Pick<NonNullable<Config["mcp"]>, "auditLog">;
  server: Pick<NonNullable<Config["server"]>, "bind">;
};

export const DEFAULT_CONFIG: DefaultConfigShape = {
  appName: "Jasper",
  theme: "dark",
  accent: "purple",
  readingFont: "sans",
  dailyNotes: {
    folder: "daily",
    template: "# {{date}}\n\n",
  },
  editor: {
    fontSize: 15,
    lineHeight: 1.45,
    autosaveMs: 2000,
    showProperties: true,
    autoPair: true,
    foldGutter: true,
    lineNumbers: false,
    lineWidth: 700,
  },
  templates: {
    folder: "Templates",
  },
  mcp: {
    auditLog: false,
  },
  // ORPHANED 2026-07-26 (ADR-002 v2): buildResetPatch's `case "server"` went
  // with the Server pane, so no reset path writes server.* any more.
  // Retained for Phase 36's Server pane; delete (with DefaultConfigShape's
  // `server` field and the parked defaults.test.ts assertions) if Phase 36
  // lands without it.
  server: {
    bind: "127.0.0.1",
  },
};
