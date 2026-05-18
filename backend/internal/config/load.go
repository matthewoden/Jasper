package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
)

// configPath returns <dataDir>/storage/config.json — same convention as
// <dataDir>/storage/app.db (Phase 2). Caller is responsible for ensuring
// the storage subdir exists before Save runs (lifecycle.go EnsureDataDir
// creates it in step 1).
func configPath(dataDir string) string {
	return filepath.Join(dataDir, "storage", "config.json")
}

// Load reads the persisted config. Behavior on edge cases (D-10 graceful
// fallback):
//   - File missing: returns DefaultConfig() AND writes it to disk so
//     subsequent reads succeed with the canonical shape.
//   - File present but malformed (invalid JSON OR unknown fields per
//     D-40 strict): logs a WARN and returns DefaultConfig() WITHOUT
//     overwriting the bad file (preserves the user's bad-state for
//     forensics; the .tmp.* trail in the same dir from any prior atomic
//     write attempt is also preserved).
//   - File present and valid: returns the parsed Config.
//
// Returns an error ONLY when the disk is unreadable for non-not-exist
// reasons (permission denied, I/O error). The caller (lifecycle.go)
// logs and continues — Phase 5 does not gate startup on config.
func Load(dataDir string, log *slog.Logger) (Config, error) {
	path := configPath(dataDir)
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		cfg := DefaultConfig()
		if writeErr := Save(dataDir, cfg); writeErr != nil {
			log.Warn("config: default emit failed",
				"path", path, "err", writeErr)
		} else {
			log.Info("config: defaults written on first run", "path", path)
		}
		return cfg, nil
	}
	if err != nil {
		return Config{}, fmt.Errorf("config read: %w", err)
	}
	// Phase 8 Plan 08-01 Task 4: start from Defaults() so old config
	// files (written before Phase 8 added the `server` / `mcp` blocks)
	// retain the canonical defaults for any nested struct field that
	// is missing on disk. json.Decoder leaves unmentioned struct
	// fields untouched, so this preserves Server.Port=6683 and
	// MCP.Port=6684 when the old config has neither block.
	cfg := DefaultConfig()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields() // D-40 strict
	if err := dec.Decode(&cfg); err != nil {
		log.Warn("config: malformed; falling back to defaults",
			"path", path, "err", err)
		return DefaultConfig(), nil
	}
	// Belt-and-suspenders defaults for nested zero-values that survived
	// a Decode where the block was present but partial (e.g. `"server":
	// {"dataDir": "/x"}` would leave Server.Port=0 because the JSON
	// overwrites the whole struct).
	if cfg.Server.Port == 0 {
		cfg.Server.Port = 6683
	}
	if cfg.MCP.Port == 0 {
		cfg.MCP.Port = 6684
	}
	if cfg.MCP.Bind == "" {
		cfg.MCP.Bind = "127.0.0.1"
	}
	return cfg, nil
}
