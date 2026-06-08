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

// configPath returns <dataDir>/.jasper/config.json — the on-disk location of
// the per-vault config file. MUST stay byte-for-byte aligned with the result
// of vault.ConfigPath(dataDir); Plan 02 originally delegated to that helper,
// but Plan 03a inlines the literal here to break the
// vault → config → vault import cycle introduced when CreateVault began
// calling config.Save. The ".jasper" literal here is therefore an authorized
// Phase-9 exception alongside vault/paths.go (per-vault helpers),
// vault/types.go (app-home), and config/defaults.go (app-home). Plan 03c's
// grep gate MUST be calibrated to allow this fourth file.
func configPath(dataDir string) string {
	return filepath.Join(dataDir, ".jasper", "config.json")
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

	cfg := DefaultConfig()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		log.Warn("config: malformed; falling back to defaults",
			"path", path, "err", err)
		return DefaultConfig(), nil
	}

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
