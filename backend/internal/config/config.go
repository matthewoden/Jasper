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
// No filesystem watcher / hot-reload (D-12); restart picks up changes.
// Strict JSON decoding (D-40): unknown fields → malformed fallback.
package config

// Config mirrors DESIGN.md §11 verbatim. JSON tags MUST stay lowercase
// first-letter (appName, dailyNotes, etc.) to match the OpenAPI Config
// schema declared in api/openapi.yaml (Plan 05-03). Drift here breaks
// GET /config + PUT /config round-trips.
type Config struct {
	AppName    string     `json:"appName"`
	DailyNotes DailyNotes `json:"dailyNotes"`
	Editor     Editor     `json:"editor"`
	Theme      string     `json:"theme"` // "dark" | "light" (enum-validated by openapi)
}

// DailyNotes — DESIGN.md §11 dailyNotes block. Phase 5 ships defaults;
// Phase 7 wires the Today button + template substitution.
type DailyNotes struct {
	Folder   string `json:"folder"`
	Template string `json:"template"`
}

// Editor — DESIGN.md §11 editor block. Phase 5 ships defaults; Phase
// UX-V2-01 surfaces in the settings panel; Phase UX-V2-02 wires vimMode.
type Editor struct {
	FontSize   int     `json:"fontSize"`
	LineHeight float64 `json:"lineHeight"`
	VimMode    bool    `json:"vimMode"`
}
