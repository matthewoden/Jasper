package config

import (
	"os"
	"path/filepath"
)

// DefaultDataDir returns the canonical per-user data directory:
//
//   - macOS / Linux: ~/.jasper
//   - Windows:       %USERPROFILE%\.jasper (Windows is not a v1 target,
//     but the helper stays portable — kardianos/service supports it).
//
// Returns "" if os.UserHomeDir fails (very rare; callers must handle
// the empty case — the first-run wizard prompts for an explicit path
// rather than crashing).
func DefaultDataDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".jasper")
}

// Defaults returns a Config populated with the DESIGN.md §11 + Phase 8
// D-50 / D-47 default values for every field. Used by:
//
//   - load.go when storage/config.json is missing (the file is then
//     written so subsequent reads succeed with the canonical shape).
//   - load.go to seed missing nested-struct fields when an old config
//     (without `server` / `mcp` blocks) is loaded — see the start-from-
//     defaults pattern in Load that ensures backward compat.
//   - The first-run wizard (Plan 08-02 PostSetup) as the baseline
//     before overlaying user choices.
//
// Server.Port is 6683 (D-50 — T9 spelling of "NOTE"). Server.DataDir
// is DefaultDataDir() so the binary boots into ~/.jasper without ever
// being run through the wizard (degraded but functional).
//
// MCP defaults: Enabled=false, Port=6684 (D-47), Bind="127.0.0.1" (D-15).
func Defaults() Config {
	return Config{
		AppName: "Jasper",
		DailyNotes: DailyNotes{
			Folder:   "daily",
			Template: "# {{date}}\n\n",
		},
		Editor: Editor{
			FontSize:   15,
			LineHeight: 1.6,
			VimMode:    false,
		},
		Theme: "dark",
		Server: ServerConfig{
			Port:    6683,
			DataDir: DefaultDataDir(),
		},
		MCP: MCPConfig{
			Enabled: false,
			Port:    6684,
			Bind:    "127.0.0.1",
		},
	}
}

// DefaultConfig is the pre-Phase-8 name for Defaults(). It remains as
// an alias so existing call sites (load.go, save_test.go, config_test.go)
// keep compiling. New callers SHOULD prefer Defaults().
//
// Theme defaults to "dark" because the persisted shape needs SOME value;
// the actual first-paint follows prefers-color-scheme via the inline
// bootstrap in frontend/index.html (D-15 — Plan 05-10 wires).
func DefaultConfig() Config {
	return Defaults()
}
