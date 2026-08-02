package workspace

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
)

// Load returns a zero-value Workspace for a missing or unparseable file, and
// errors only when the disk is unreadable for non-not-exist reasons.
//
// An unknown field must never be treated like corrupt JSON — that would coerce
// a newer binary's document back to defaults.
func Load(dataDir string, log *slog.Logger) (Workspace, error) {
	path := workspacePath(dataDir)
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Workspace{}, nil
	}
	if err != nil {
		return Workspace{}, fmt.Errorf("workspace read: %w", err)
	}

	var doc Workspace
	dec := json.NewDecoder(bytes.NewReader(raw))
	// No DisallowUnknownFields(): an unrecognized field must not be treated
	// the same as corrupt JSON — see doc comment above.
	if err := dec.Decode(&doc); err != nil {
		log.Warn("workspace: malformed; falling back to defaults",
			"path", path, "err", err)
		return Workspace{}, nil
	}

	return doc, nil
}
