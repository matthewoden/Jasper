package config

import (
	"os"
	"path/filepath"
)

// DefaultDataDir returns the canonical per-user data directory:
//
//   - macOS / Linux: ~/.jasper
//   - Windows:       %USERPROFILE%\.jasper (Windows is not a v1 target,
//     but the helper stays portable).
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

// Defaults returns a Config populated with DESIGN.md §11 default values
// for every field. Used by:
//
//   - load.go when .jasper/config.json is missing (the file is then
//     written so subsequent reads succeed with the canonical shape).
//   - load.go to seed missing nested-struct fields when an old config
//     (without `server` / `mcp` blocks) is loaded.
//   - The first-run wizard as the baseline before overlaying user choices.
//
// Server.Port is 6683 (T9 spelling of "NOTE"). Server.DataDir is
// DefaultDataDir() so the binary boots into ~/.jasper without a wizard run.
//
// MCP defaults: Enabled=true (default-on so grant UI works out of the box),
// Port=6684, Bind="127.0.0.1". Listener still only binds loopback; user
// can disable via config.json or the settings UI.
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
			AutosaveMs: 2000,
		},
		Theme: "dark",
		Server: ServerConfig{
			Port:    6683,
			DataDir: DefaultDataDir(),
		},
		MCP: MCPConfig{
			Enabled: true,
			Port:    6684,
			Bind:    "127.0.0.1",
		},
	}
}

// DefaultConfig is a deprecated alias for Defaults(). Kept so existing
// call sites keep compiling. New callers SHOULD prefer Defaults().
//
// Theme defaults to "dark" because the persisted shape needs SOME value;
// the actual first-paint follows prefers-color-scheme via the inline
// bootstrap in frontend/index.html.
func DefaultConfig() Config {
	return Defaults()
}
