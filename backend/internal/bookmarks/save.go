package bookmarks

import (
	"encoding/json"
	"fmt"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
)

// Save writes b to <dataDir>/.jasper/bookmarks.json atomically via
// fsstore.AtomicWrite (temp + fsync + rename + fsync(parent)).
// Indented JSON so a human can `cat` the file and read it.
//
// Caller is responsible for ensuring <dataDir>/.jasper exists.
func Save(dataDir string, b Bookmarks) error {
	data, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return fmt.Errorf("bookmarks marshal: %w", err)
	}
	if err := fsstore.AtomicWrite(bookmarksPath(dataDir), data); err != nil {
		return fmt.Errorf("bookmarks save: %w", err)
	}
	return nil
}
