// Package config owns <dataDir>/.jasper/config.json. No in-memory state: every
// Load reads disk, every Save writes atomically.
//
// Read is lenient per field, write is strict (ADR-0020). The asymmetry is
// intentional and must not be blurred.
package config

// Config mirrors the DESIGN.md §11 schema.
// JSON tags MUST stay lowercase first-letter (appName, dailyNotes, etc.)
// to match the OpenAPI Config schema declared in api/openapi.yaml.
// Drift here breaks GET /config + PUT /config round-trips.
type Config struct {
	AppName     string       `json:"appName"`
	DailyNotes  DailyNotes   `json:"dailyNotes"`
	Editor      Editor       `json:"editor"`
	Theme       string       `json:"theme"`                 // "dark" | "light" (pinned to "dark" at load)
	Accent      string       `json:"accent,omitempty"`      // "purple"|"sky"|"green"|"orange"; default "purple"
	ReadingFont string       `json:"readingFont,omitempty"` // "sans"|"serif"; default "sans"
	Server      ServerConfig `json:"server"`                // port (6683) + dataDir source of truth
	MCP         MCPConfig    `json:"mcp"`                   // optional MCP listener
	Templates   Templates    `json:"templates"`             // TPL-01 templates folder
}

// Templates — TPL-01 templates block.
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
	// ShowProperties toggles the properties table above the note body.
	ShowProperties bool `json:"showProperties"`
	// AutoPair auto-closes brackets/quotes in the CM6 editor (EDIT-01).
	AutoPair bool `json:"autoPair"`
	// FoldGutter shows the heading/list code-folding gutter (EDIT-03).
	FoldGutter bool `json:"foldGutter"`
	// LineNumbers shows the CM6 line-number gutter (EDIT-03).
	LineNumbers bool `json:"lineNumbers"`
	// LineWidth is the maximum width of the writing column, in CSS pixels
	// (EDIT-04). Range 400-2000.
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
// StreamableHTTP endpoint. The listener always starts on boot; AI write
// access is governed solely by per-folder write grants.
//
//   - Port defaults to 6684.
//   - Bind defaults to "127.0.0.1" and is enforced loopback-only at
//     listener startup via netbind.RequireLoopbackBind.
type MCPConfig struct {
	Port int    `json:"port"`
	Bind string `json:"bind"`
	// AuditLog toggles the MCP tool-call audit log (MCP2-02).
	AuditLog bool `json:"auditLog"`
	// There is deliberately no on/off toggle field: its only justification
	// was the strict decoder (DisallowUnknownFields), which the read path
	// no longer uses. A legacy on-disk mcp.enabled key is just an unknown
	// nested key — dropped on lenient read, preserved on write.
}
