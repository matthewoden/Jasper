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

// Load reads the persisted workspace document. Behavior on edge cases:
//   - File missing: returns a zero-value Workspace{} with nil error.
//   - File present but malformed (genuinely unparseable JSON): logs a WARN
//     and returns a zero-value Workspace{}, never an error to the caller.
//   - File present and valid — including a well-formed document carrying an
//     extra/unrecognized field (e.g. written by a newer binary, or
//     hand-edited): unknown fields are ignored, matching normal Go JSON
//     decode semantics (mirrors the SET-05 / bookmarks CR-01 forward-compat
//     lesson — an unknown field must never be treated the same as corrupt
//     JSON and coerced to a default document).
//
// Returns an error ONLY when the disk is unreadable for non-not-exist
// reasons (permission denied, I/O error).
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
