package config

import (
	"encoding/json"
	"fmt"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
)

// Save writes c to <dataDir>/storage/config.json atomically via
// fsstore.AtomicWrite (DATA-13 — temp+rename+fsync(parent)).
// Indented JSON so a human can `cat` the file and read it.
//
// Caller is responsible for ensuring <dataDir>/storage exists.
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
