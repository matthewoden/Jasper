/**
 * Frontend mirror of `backend/internal/config/defaults.go`'s `Defaults()`, scoped
 * to the fields a per-pane Reset may write. `server.port`, `server.dataDir` and
 * `mcp.port` are deliberately omitted — a Reset must never rewrite the listening
 * port or data directory.
 *
 * TypeScript cannot see the Go source, so nothing links the two at compile time.
 * The E2E Reset assertions compare a fresh vault's GET /config against these
 * values, and are the only thing that catches drift.
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
  // Retained for a future Server pane; delete (with DefaultConfigShape's
  // `server` field and the parked defaults.test.ts assertions) if no such
  // pane ever lands.
  server: {
    bind: "127.0.0.1",
  },
};
