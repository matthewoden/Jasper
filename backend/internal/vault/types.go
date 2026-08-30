// Package vault implements the app-level state registry. The on-disk format
// is ~/.jasper/app.json (fixed location, overridable via $JASPER_APP_HOME).
// Per-entry fields: path, display_name, last_opened_at, created_at, missing.
// Canonical dedup via filepath.Abs → EvalSymlinks → Clean → (darwin) ToLower.
package vault

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// AppState is the on-disk shape of ~/.jasper/app.json.
// JSON keys are fixed; downstream handlers read these names verbatim.
type AppState struct {
	CurrentVault     string             `json:"current_vault,omitempty"`      // abs canonical path; empty => no vault selected
	RecentVaults     []RecentVaultEntry `json:"recent_vaults"`                // newest first (LRU sort by LastOpenedAt desc)
	ThemeBootstrap   string             `json:"theme_bootstrap,omitempty"`    // "dark" | "light"; bootstraps before per-vault config loads
	MCPGlobalEnabled bool               `json:"mcp_global_enabled,omitempty"` // app-level kill-switch
	ServerPort       int                `json:"server_port,omitempty"`        // app-level override; 0 => use 6683 default
}

// RecentVaultEntry is one entry in AppState.RecentVaults.
type RecentVaultEntry struct {
	Path         string    `json:"path"`              // abs canonical (V10)
	DisplayName  string    `json:"display_name"`      // defaults to filepath.Base(path) (V9)
	LastOpenedAt time.Time `json:"last_opened_at"`    // RFC3339 UTC; drives LRU sort
	CreatedAt    time.Time `json:"created_at"`        // RFC3339 UTC; when first registered
	Missing      bool      `json:"missing,omitempty"` // set on boot when os.Stat fails (V11)
}

// AppHomePath returns $JASPER_APP_HOME if set, else $HOME/.jasper.
// This is the directory that contains app.json (the app-level registry).
// It is intentionally the same path the prior boot model used as the
// default data-dir; under the vault model it is the app home and
// current_vault selects the actual vault.
func AppHomePath() (string, error) {
	if v := os.Getenv("JASPER_APP_HOME"); v != "" {
		return filepath.Clean(v), nil
	}
	// Under `go test` the real ~/.jasper is never the right answer: a test that
	// falls through to it rewrites the developer's own recent-vault list. Refuse
	// loudly instead, so the missing isolation surfaces as a failure.
	if testing.Testing() {
		return "", errors.New("app home: refusing the real ~/.jasper under go test — set JASPER_APP_HOME (t.Setenv(\"JASPER_APP_HOME\", t.TempDir()))")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve $HOME for app home: %w", err)
	}
	return filepath.Join(home, ".jasper"), nil
}

// AppJSONPath returns AppHomePath()/app.json.
func AppJSONPath() (string, error) {
	home, err := AppHomePath()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "app.json"), nil
}
