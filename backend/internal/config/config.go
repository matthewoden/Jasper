// Package config owns Jasper's user configuration file (DESIGN.md §11).
// The file lives at <dataDir>/.jasper/config.json. The filesystem is the
// source of truth; the package never holds in-memory state across calls
// — every Load reads disk, every Save writes via fsstore.AtomicWrite
// (temp + fsync + rename + fsync(parent)).
//
// No filesystem watcher / hot-reload; restart picks up changes.
//
// Read/write asymmetry (D-16): Load is lenient — a hand-edited, older-, or
// newer-binary config.json degrades per-field (unrecognized keys are
// dropped; a wrong-typed or out-of-range known field reverts to its own
// default) instead of nuking the whole document. The write path
// (ConfigStrictBodyMiddleware's strictConfigValidator, PUT /config) stays
// strict — a malformed or unknown field there is rejected before it ever
// reaches disk. This asymmetry is intentional and must not be blurred.
package config

// Config mirrors the DESIGN.md §11 schema.
// JSON tags MUST stay lowercase first-letter (appName, dailyNotes, etc.)
// to match the OpenAPI Config schema declared in api/openapi.yaml.
// Drift here breaks GET /config + PUT /config round-trips.
type Config struct {
	AppName     string       `json:"appName"`
	DailyNotes  DailyNotes   `json:"dailyNotes"`
	Editor      Editor       `json:"editor"`
	Theme       string       `json:"theme"`                 // "dark" | "light" (D-02: pinned to "dark" at load)
	Accent      string       `json:"accent,omitempty"`      // "purple"|"sky"|"green"|"orange"; default "purple"
	ReadingFont string       `json:"readingFont,omitempty"` // "sans"|"serif"; default "sans"
	Server      ServerConfig `json:"server"`                // port (6683) + dataDir source of truth
	MCP         MCPConfig    `json:"mcp"`                   // optional MCP listener
	Templates   Templates    `json:"templates"`             // Phase 35 / TPL-01 templates folder
}

// Templates — Phase 35 / TPL-01 templates block.
type Templates struct {
	Folder string `json:"folder"`
}

// DailyNotes — DESIGN.md §11 dailyNotes block.
type DailyNotes struct {
	Template string `json:"template"`
}

// Editor — DESIGN.md §11 editor block.
// AutosaveMs replaces the hard-coded 2000ms constant in EditorPane.tsx;
// validated range 250–10000 ms (config_validate.go).
type Editor struct {
	FontSize   int     `json:"fontSize"`
	LineHeight float64 `json:"lineHeight"`
	AutosaveMs int     `json:"autosaveMs"`
	// ShowProperties toggles the properties table above the note body (Phase 34).
	ShowProperties bool `json:"showProperties"`
	// AutoPair auto-closes brackets/quotes in the CM6 editor (Phase 37 / EDIT-01).
	AutoPair bool `json:"autoPair"`
	// FoldGutter shows the heading/list code-folding gutter (Phase 37 / EDIT-03).
	FoldGutter bool `json:"foldGutter"`
	// LineNumbers shows the CM6 line-number gutter (Phase 37 / EDIT-03).
	LineNumbers bool `json:"lineNumbers"`
	// LineWidth is the maximum width of the writing column, in CSS pixels
	// (Phase 37 / EDIT-04). Range 400-2000.
	LineWidth int `json:"lineWidth"`
}

// ServerConfig holds the HTTP listener's port and the user's data directory.
//
//   - Port defaults to 6683 (T9 spelling of "NOTE"). The wizard does NOT
//     expose a port override; users edit config.json directly to change ports.
//   - DataDir is set by the first-run wizard at submit time and re-read at
//     every boot via load.go.
//   - Bind defaults to "127.0.0.1" (loopback-only). Set to "0.0.0.0" to
//     expose the HTTP listener on all network interfaces. Requires a server
//     restart. MCP always binds loopback regardless of this value.
type ServerConfig struct {
	Port    int    `json:"port"`
	DataDir string `json:"dataDir"`
	Bind    string `json:"bind,omitempty"`
}

// MCPConfig controls the second HTTP listener that serves the MCP
// StreamableHTTP endpoint. The listener always starts on boot (Phase 24
// D-06); AI write access is governed solely by per-folder write grants.
//
//   - Port defaults to 6684.
//   - Bind defaults to "127.0.0.1" and is enforced loopback-only at
//     listener startup via netbind.RequireLoopbackBind.
type MCPConfig struct {
	Port int    `json:"port"`
	Bind string `json:"bind"`
	// AuditLog toggles the MCP tool-call audit log (Phase 36 / MCP2-02).
	AuditLog bool `json:"auditLog"`
	// NOTE (Phase 32, closes RESEARCH.md Open Question 2): the old on/off
	// toggle field is deleted here — its only justification was the strict
	// decoder (DisallowUnknownFields), which Phase 32-03 removes. A legacy
	// on-disk mcp.enabled key becomes an unknown nested key — dropped on
	// lenient read, preserved on write.
}
