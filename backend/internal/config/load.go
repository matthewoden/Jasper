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
