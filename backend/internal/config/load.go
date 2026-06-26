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
	"strconv"
)

// withEnvMCPPort applies the JASPER_MCP_PORT override (highest precedence) so
// each E2E test binary can bind its MCP listener to its own ephemeral port,
// eliminating contention on the fixed default (6684) when many test binaries
// run in parallel. Ignored when unset or invalid. Applied uniformly to every
// Load() return so first-boot and the vault-switch listener both honor it.
func withEnvMCPPort(cfg Config) Config {
	if v := os.Getenv("JASPER_MCP_PORT"); v != "" {
		if p, err := strconv.Atoi(v); err == nil && p > 0 && p <= 65535 {
			cfg.MCP.Port = p
		}
	}
	return cfg
}

// configPath returns <dataDir>/.jasper/config.json — the on-disk location of
// the per-vault config file. MUST stay byte-for-byte aligned with the result
// of vault.ConfigPath(dataDir). The ".jasper" literal is inlined here to
// break the vault → config → vault import cycle introduced when CreateVault
// began calling config.Save.
func configPath(dataDir string) string {
	return filepath.Join(dataDir, ".jasper", "config.json")
}

// Load reads the persisted config. Behavior on edge cases:
//   - File missing: returns DefaultConfig() AND writes it to disk so
//     subsequent reads succeed with the canonical shape.
//   - File present but malformed (invalid JSON OR unknown fields — strict
//     decoding): logs a WARN and returns DefaultConfig() WITHOUT overwriting
//     the bad file (preserves the user's state for forensics).
//   - File present and valid: returns the parsed Config.
//
// Returns an error ONLY when the disk is unreadable for non-not-exist
// reasons (permission denied, I/O error). The caller logs and continues;
// startup is not gated on config.
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
		return withEnvMCPPort(cfg), nil
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
		return withEnvMCPPort(DefaultConfig()), nil
	}

	if cfg.Server.Port == 0 {
		cfg.Server.Port = 6683
	}
	if cfg.Server.Bind == "" {
		cfg.Server.Bind = "127.0.0.1"
	}
	if cfg.MCP.Port == 0 {
		cfg.MCP.Port = 6684
	}
	if cfg.MCP.Bind == "" {
		cfg.MCP.Bind = "127.0.0.1"
	}
	return withEnvMCPPort(cfg), nil
}
