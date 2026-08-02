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

// Load reads the persisted bookmarks document, returning an error only when the
// disk is unreadable for non-not-exist reasons.
//
// An unknown field must never be treated like corrupt JSON: coercing it to an
// empty document would wipe every bookmark on the next write.
//
// Bookmarks whose NoteID no longer resolves are pruned on read and the pruned
// document re-saved. A nil registry skips pruning entirely — it resolves
// nothing, so pruning against it would wipe every valid row.
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
