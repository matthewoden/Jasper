// Package config owns Jasper's user configuration file (DESIGN.md §11).
// The file lives at <dataDir>/storage/config.json. The filesystem is the
// source of truth; the package never holds in-memory state across calls
// — every Load reads disk, every Save writes via fsstore.AtomicWrite
// (DATA-13: temp + fsync + rename + fsync(parent)).
//
// Phase 5 wires only the Theme field to UI (D-11). The other fields ship
// with the DESIGN.md §11 defaults so future phases (UX-V2-01 settings
// panel; daily-notes; editor.fontSize) can surface them without a
// schema migration.
//
// Phase 8 Plan 08-01 Task 4 extends the schema with TWO new blocks:
//
//   - Server (D-50 / D-40): the HTTP listener port + resolved data dir.
//     Port pinned at 6683 (T9 spelling of "NOTE"); DataDir is set by
//     the first-run wizard (08-02 / D-04) and read at every boot.
//   - MCP (D-14 / D-15 / D-47): optional secondary listener serving the
//     MCP StreamableHTTP endpoint. Disabled by default; the wizard
//     writes Enabled based on the opt-in checkbox. Port 6684; Bind
//     "127.0.0.1" (loopback-only via netbind.RequireLoopbackBind).
//
// Both blocks are OPTIONAL in api/openapi.yaml's Config schema so
// existing config.json files (written before Phase 8) continue to
// load; load.go applies defaults when the blocks are missing.
//
// No filesystem watcher / hot-reload (D-12); restart picks up changes.
// Strict JSON decoding (D-40): unknown fields → malformed fallback.
package config

// Config mirrors DESIGN.md §11 + Phase 8 D-50 / D-47 additions verbatim.
// JSON tags MUST stay lowercase first-letter (appName, dailyNotes, etc.)
// to match the OpenAPI Config schema declared in api/openapi.yaml
// (Plan 05-03 / 08-01). Drift here breaks GET /config + PUT /config
// round-trips.
type Config struct {
	AppName string `json:"appName"`
	// DisplayName is the human-readable vault name (Phase 9 D-04). Optional on disk
	// (`omitempty`) — legacy configs written before Phase 9 still parse cleanly under
	// the strict decoder. CreateVault populates it from CreateOpts.DisplayName (or
	// filepath.Base(canonical)); readers fall back to filepath.Base at display time
	// when the field is "".
	DisplayName string       `json:"display_name,omitempty"`
	DailyNotes  DailyNotes   `json:"dailyNotes"`
	Editor      Editor       `json:"editor"`
	Theme       string       `json:"theme"`  // "dark" | "light" (enum-validated by openapi)
	Server      ServerConfig `json:"server"` // Phase 8 D-50: port (6683) + dataDir source of truth
	MCP         MCPConfig    `json:"mcp"`    // Phase 8 D-47: optional MCP listener (revision 2 consolidation from 08-09)
}

// DailyNotes — DESIGN.md §11 dailyNotes block. Phase 5 ships defaults;
// Phase 7 wires the Today button + template substitution.
type DailyNotes struct {
	Folder   string `json:"folder"`
	Template string `json:"template"`
}

// Editor — DESIGN.md §11 editor block. Phase 5 ships defaults; Phase
// UX-V2-01 surfaces in the settings panel; Phase UX-V2-02 wires vimMode.
// Phase 11 D-08 adds AutosaveMs: replaces the hard-coded 2000ms constant
// in EditorPane.tsx. Validated range 250–10000 ms (config_validate.go).
type Editor struct {
	FontSize   int     `json:"fontSize"`
	LineHeight float64 `json:"lineHeight"`
	VimMode    bool    `json:"vimMode"`
	AutosaveMs int     `json:"autosaveMs"`
}

// ServerConfig — Phase 8 D-40 / D-50. The HTTP listener's port and the
// user's data directory.
//
//   - Port defaults to 6683 (D-50 — T9 spelling of "NOTE"). The wizard
//     does NOT expose a port override; users edit config.json directly
//     to migrate ports (see scripts/port.sh from Plan 08-13).
//   - DataDir is set by the first-run wizard (D-04) at submit time
//     (Plan 08-02 writes cfg.Server.DataDir = req.DataDir before
//     persisting config.json). Re-read at every boot via load.go.
type ServerConfig struct {
	Port    int    `json:"port"`
	DataDir string `json:"dataDir"`
}

// MCPConfig — Phase 8 D-14 / D-15 / D-47. Controls the optional second
// HTTP listener that serves the MCP StreamableHTTP endpoint.
//
//   - Enabled defaults to false; the first-run wizard offers a checkbox
//     (Plan 08-02 wizard submit persists cfg.MCP.Enabled = req.McpEnabled).
//   - Port defaults to 6684 (D-47).
//   - Bind defaults to "127.0.0.1" and is enforced loopback-only at
//     listener startup (D-15) via netbind.RequireLoopbackBind.
//
// Revision 2 consolidation: this struct used to live in 08-09 Task 2
// (Wave 4). Moved into Plan 08-01 (Wave 1) so 08-02 (Wave 2) can set
// cfg.MCP.Enabled at wizard submit time without a Wave 4 dependency.
type MCPConfig struct {
	Enabled bool   `json:"enabled"`
	Port    int    `json:"port"`
	Bind    string `json:"bind"`
}
