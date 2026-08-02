package bookmarks

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// Load reads the persisted bookmarks document. Behavior on edge cases:
//   - File missing: returns an empty Bookmarks{} (NOT a default-emit — an
//     empty vault legitimately has no bookmarks yet) with nil error.
//   - File present but malformed (genuinely unparseable JSON): logs a WARN
//     and returns an empty Bookmarks{}, never an error to the caller.
//   - File present and valid — including a well-formed document carrying an
//     extra/unrecognized field (e.g. written by a newer binary, or hand-
//     edited): unknown fields are ignored, matching normal Go JSON decode
//     semantics (mirrors the SET-05 forward-compat lesson —
//     an unknown field must never be treated the same as corrupt JSON and
//     coerced to an empty document, which would silently wipe every
//     bookmark and folder on the next write).
//   - File present and valid: any bookmark whose NoteID no longer resolves
//     in registry (or fails to parse as a UUID) is dropped
//     (auto-prune-on-read). If any row was dropped, the pruned document is
//     re-Saved to disk (best-effort) so the file stays clean.
//   - registry == nil (Server's documented graceful-degradation
//     contract when notesSvc is nil): auto-prune is skipped entirely — a
//     nil registry cannot legitimately resolve anything, so pruning against
//     it would wipe every valid row and re-Save that empty result, which
//     would be a real data-loss bug of exactly that shape. The document
//     is returned as-is, unpruned.
//
// Returns an error ONLY when the disk is unreadable for non-not-exist
// reasons (permission denied, I/O error).
func Load(dataDir string, registry *notes.Registry, log *slog.Logger) (Bookmarks, error) {
	path := bookmarksPath(dataDir)
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Bookmarks{}, nil
	}
	if err != nil {
		return Bookmarks{}, fmt.Errorf("bookmarks read: %w", err)
	}

	var doc Bookmarks
	dec := json.NewDecoder(bytes.NewReader(raw))
	// No DisallowUnknownFields(): an unrecognized field must not be treated
	// the same as corrupt JSON — see the doc comment above.
	if err := dec.Decode(&doc); err != nil {
		log.Warn("bookmarks: malformed; falling back to empty set",
			"path", path, "err", err)
		return Bookmarks{}, nil
	}

	if registry == nil {
		return doc, nil
	}

	pruned := make([]Bookmark, 0, len(doc.Bookmarks))
	for _, bm := range doc.Bookmarks {
		id, parseErr := uuid.Parse(bm.NoteID)
		if parseErr != nil {
			continue
		}
		if _, ok := registry.Lookup(id); !ok {
			continue
		}
		pruned = append(pruned, bm)
	}

	if len(pruned) != len(doc.Bookmarks) {
		doc.Bookmarks = pruned
		if saveErr := Save(dataDir, doc); saveErr != nil {
			log.Warn("bookmarks: prune-on-read save failed",
				"path", path, "err", saveErr)
		}
	}

	return doc, nil
}
