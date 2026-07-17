// Package config owns Jasper's user configuration file (DESIGN.md §11).
// The file lives at <dataDir>/.jasper/config.json. The filesystem is the
// source of truth; the package never holds in-memory state across calls
// — every Load reads disk, every Save writes via fsstore.AtomicWrite
// (temp + fsync + rename + fsync(parent)).
//
// No filesystem watcher / hot-reload; restart picks up changes.
// Strict JSON decoding: unknown fields → malformed fallback.
package config

// Config mirrors the DESIGN.md §11 schema.
// JSON tags MUST stay lowercase first-letter (appName, dailyNotes, etc.)
// to match the OpenAPI Config schema declared in api/openapi.yaml.
// Drift here breaks GET /config + PUT /config round-trips.
type Config struct {
	AppName string `json:"appName"`
	// DisplayName is the human-readable vault name. Optional on disk
	// (`omitempty`) — legacy configs without this field still parse cleanly
	// under the strict decoder. CreateVault populates it from
	// CreateOpts.DisplayName (or filepath.Base(canonical)); readers fall
	// back to filepath.Base at display time when the field is "".
	DisplayName string       `json:"display_name,omitempty"`
	DailyNotes  DailyNotes   `json:"dailyNotes"`
	Editor      Editor       `json:"editor"`
	Theme       string       `json:"theme"`                 // "dark" | "light" (D-02: pinned to "dark" at load)
	Accent      string       `json:"accent,omitempty"`      // "purple"|"sky"|"green"|"orange"; default "purple"
	ReadingFont string       `json:"readingFont,omitempty"` // "sans"|"serif"; default "sans"
	Server      ServerConfig `json:"server"`                // port (6683) + dataDir source of truth
	MCP         MCPConfig    `json:"mcp"`                   // optional MCP listener
}

// DailyNotes — DESIGN.md §11 dailyNotes block.
type DailyNotes struct {
	Folder   string `json:"folder"`
	Template string `json:"template"`
}

// Editor — DESIGN.md §11 editor block.
// AutosaveMs replaces the hard-coded 2000ms constant in EditorPane.tsx;
// validated range 250–10000 ms (config_validate.go).
type Editor struct {
	FontSize   int     `json:"fontSize"`
	LineHeight float64 `json:"lineHeight"`
	VimMode    bool    `json:"vimMode"`
	AutosaveMs int     `json:"autosaveMs"`
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
	// Enabled is a deprecated no-op. Before Phase 24 the wizard always
	// persisted "mcp":{"enabled":...}, so every pre-24 config.json on disk
	// carries this key. It is retained (`omitempty`) only so those legacy
	// files still parse under the strict decoder (DisallowUnknownFields) —
	// dropping it would send every upgrading user down the malformed-fallback
	// path and silently reset their settings. The listener is now always-on
	// (D-06); this field is read and ignored. Do not reintroduce a toggle.
	Enabled bool `json:"enabled,omitempty"`
}
