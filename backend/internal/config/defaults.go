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

// Defaults returns a fully-populated Config. Server.DataDir defaults to
// DefaultDataDir() so the binary boots into ~/.jasper without a wizard run.
func Defaults() Config {
	return Config{
		AppName: "Jasper",
		DailyNotes: DailyNotes{
			Template: "# {{date}}\n\n",
		},
		Editor: Editor{
			FontSize:       15,
			LineHeight:     1.45,
			AutosaveMs:     2000,
			ShowProperties: true,
			AutoPair:       true,
			FoldGutter:     true,
			LineNumbers:    false,
			LineWidth:      700,
		},
		Theme:       "dark",
		Accent:      "purple",
		ReadingFont: "sans",
		Server: ServerConfig{
			Port:    6683,
			DataDir: DefaultDataDir(),
			Bind:    "127.0.0.1",
		},
		MCP: MCPConfig{
			Port:     6684,
			Bind:     "127.0.0.1",
			AuditLog: false,
		},
		Templates: Templates{
			Folder: "Templates",
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
