package workspace

import (
	"encoding/json"
	"fmt"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
)

// Save writes w to <dataDir>/.jasper/workspace.json atomically via
// fsstore.AtomicWrite (temp + fsync + rename + fsync(parent)).
// Indented JSON so a human can `cat` the file and read it.
//
// Caller is responsible for ensuring <dataDir>/.jasper exists.
func Save(dataDir string, w Workspace) error {
	data, err := json.MarshalIndent(w, "", "  ")
	if err != nil {
		return fmt.Errorf("workspace marshal: %w", err)
	}
	if err := fsstore.AtomicWrite(workspacePath(dataDir), data); err != nil {
		return fmt.Errorf("workspace save: %w", err)
	}
	return nil
}
