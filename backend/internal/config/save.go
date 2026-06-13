package config

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
)

// Save writes c to <dataDir>/.jasper/config.json atomically via
// fsstore.AtomicWrite (DATA-13 — temp+rename+fsync(parent)).
// Indented JSON so a human can `cat` the file and read it.
//
// Caller is responsible for ensuring <dataDir>/.jasper exists.
// lifecycle.EnsureDataDir creates it during boot.
func Save(dataDir string, c Config) error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("config marshal: %w", err)
	}
	if err := fsstore.AtomicWrite(configPath(dataDir), data); err != nil {
		return fmt.Errorf("config save: %w", err)
	}
	return nil
}

// SaveMerged reads the raw on-disk JSON, overlays the managed keys from
// updates onto it (preserving any unmanaged/unknown keys), and writes back
// atomically. This prevents a PUT /config round-trip from dropping keys
// added by hand or by a newer binary version (D-09 / SET-05).
//
// Load intentionally uses DisallowUnknownFields (D-40) — this function
// does NOT relax that. Load is the read-path; SaveMerged is write-path only.
//
// Algorithm:
//  1. Read existing disk JSON into map[string]json.RawMessage (best-effort).
//  2. Marshal updates to JSON, decode into overlay map.
//  3. Overlay managed keys onto existing map, preserving unknown keys.
//  4. MarshalIndent merged map and AtomicWrite to disk.
func SaveMerged(dataDir string, updates Config, log *slog.Logger) error {
	existing := map[string]json.RawMessage{}
	if raw, err := os.ReadFile(configPath(dataDir)); err == nil {
		if err := json.Unmarshal(raw, &existing); err != nil {
			log.Warn("SaveMerged: could not parse existing config; starting from scratch",
				"err", err)
			existing = map[string]json.RawMessage{}
		}
	}

	managed, err := json.Marshal(updates)
	if err != nil {
		return fmt.Errorf("config marshal: %w", err)
	}

	var overlay map[string]json.RawMessage
	if err := json.Unmarshal(managed, &overlay); err != nil {
		return fmt.Errorf("config overlay parse: %w", err)
	}

	for k, v := range overlay {
		existing[k] = v
	}

	merged, err := json.MarshalIndent(existing, "", "  ")
	if err != nil {
		return fmt.Errorf("config merge marshal: %w", err)
	}

	if err := fsstore.AtomicWrite(configPath(dataDir), merged); err != nil {
		return fmt.Errorf("config save merged: %w", err)
	}
	return nil
}
