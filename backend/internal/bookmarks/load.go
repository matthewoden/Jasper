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
// Bookmarks whose NoteID no longer resolves are re-resolved by Path where
// possible and pruned otherwise; a changed document is re-saved. A nil
// registry skips both entirely — it resolves nothing, so pruning against it
// would wipe every valid row.
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

	kept := make([]Bookmark, 0, len(doc.Bookmarks))
	changed := false
	// Built lazily: the common read resolves every id and never needs it.
	var byPath map[string]uuid.UUID

	for _, bm := range doc.Bookmarks {
		id, parseErr := uuid.Parse(bm.NoteID)
		if parseErr != nil {
			changed = true
			continue
		}

		if relPath, ok := registry.Lookup(id); ok {
			// Keep the hint current, or a later rebuild resolves a path the
			// note left behind — which is how a rename would quietly disarm
			// the recovery below.
			if bm.Path != relPath {
				bm.Path = relPath
				changed = true
			}
			kept = append(kept, bm)
			continue
		}

		if bm.Path == "" {
			changed = true
			continue
		}
		if byPath == nil {
			byPath = registry.PathIndex()
		}
		newID, ok := byPath[bm.Path]
		if !ok {
			changed = true
			continue
		}
		// The id was re-minted under this note (a full rebuild) — adopt it
		// rather than dropping a row the user authored. Path is the only
		// identity signal left, so a note now occupying a deleted note's
		// path inherits its bookmark; that is the hint working as intended.
		log.Info("bookmarks: re-resolved bookmark by path after id change",
			"bookmark", bm.ID, "path", bm.Path,
			"old_note_id", bm.NoteID, "new_note_id", newID.String())
		bm.NoteID = newID.String()
		changed = true
		kept = append(kept, bm)
	}

	if changed {
		doc.Bookmarks = kept
		if saveErr := Save(dataDir, doc); saveErr != nil {
			log.Warn("bookmarks: heal-on-read save failed",
				"path", path, "err", saveErr)
		}
	}

	return doc, nil
}
