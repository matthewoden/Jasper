package notes

import (
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/google/uuid"
	"golang.org/x/text/unicode/norm"
)

// ScratchpadUUID is the hard-coded UUID for the scratchpad note.
// Matches the example in api/openapi.yaml.
var ScratchpadUUID = uuid.MustParse("00000000-0000-4000-a000-000000000001")

// ScratchpadRelPath is the canonical relative path under notes/ for the scratchpad.
const ScratchpadRelPath = "scratchpad.md"

// ScratchpadWelcome is the seed content written to scratchpad.md if the
// file does not exist on first server start. ~290 bytes including the
// trailing newline.
//
// The exact bytes matter: this is what the user sees when they open
// Jasper for the first time. Do NOT paraphrase. The em-dash and ⌘ symbol
// are intentional (Mac-first). The path inside the backticks is the
// default vault root.
const ScratchpadWelcome = "# Welcome to Jasper\n" +
	"\n" +
	"This is your scratchpad. Edit anything — your changes save automatically a moment after you stop typing, or immediately when you press ⌘S.\n" +
	"\n" +
	"This file lives at `~/.jasper/notes/scratchpad.md`. Open it with any editor; it's just markdown.\n"

// Registry maps UUIDs to canonical relative paths. It also maintains a
// title→records index for wiki-link resolution. Ambiguous titles resolve
// same-folder-first, then alphabetical.
//
// The byTitle map is keyed by NFC-normalized lowercase title, pointing to
// a slice of NoteRecords that share that normalized title. The slice is
// maintained in lockstep with byID across all mutation methods.
type Registry struct {
	mu      sync.RWMutex
	byID    map[uuid.UUID]string
	byTitle map[string][]NoteRecord
}

// NewRegistry returns a Registry seeded with the scratchpad mapping.
func NewRegistry() *Registry {
	return &Registry{
		byID:    map[uuid.UUID]string{ScratchpadUUID: ScratchpadRelPath},
		byTitle: make(map[string][]NoteRecord),
	}
}

// Lookup returns the canonical relPath for a UUID, or "", false if unknown.
func (r *Registry) Lookup(id uuid.UUID) (string, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	relPath, ok := r.byID[id]
	return relPath, ok
}

// Add inserts (or overwrites) the id → relPath mapping. Called by
// Service.Create after the file write + index upsert succeed. Idempotent:
// re-Adding the same id replaces the path in place.
//
// Note: Add does NOT update the title map because it does not receive the
// note title. Use AddRecord or HydrateRecords for full title-index maintenance.
func (r *Registry) Add(id uuid.UUID, relPath string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.byID[id] = relPath
}

// AddRecord inserts or overwrites the id mapping AND updates the title
// index. Call this instead of Add when the note title is known (e.g.
// after Service.Create or Service.Update succeeds).
//
// titleNormalized must be the NFC-normalized lowercase title string (the
// caller is responsible for normalization — the registry stores and
// queries using the same canonical form).
func (r *Registry) AddRecord(id uuid.UUID, relPath, titleNormalized string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.byID[id] = relPath

	r.removeTitleEntryLocked(id)

	key := titleKey(titleNormalized)
	rec := NoteRecord{ID: id, Path: relPath, Title: titleNormalized}
	r.byTitle[key] = append(r.byTitle[key], rec)
}

// Remove deletes the mapping for id. Idempotent — removing an absent id
// is a no-op (the registry can be ahead/behind reality during reconcile).
// Called by Service.Delete after a successful FS delete. Also removes
// the entry from the title index.
func (r *Registry) Remove(id uuid.UUID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.removeTitleEntryLocked(id)
	delete(r.byID, id)
}

// Rename updates the relPath for id IF the id is already present.
// Insert-on-rename is intentionally NOT supported: Service.Move is the
// only caller and it always calls Add → Rename, never Rename for a fresh id.
//
// Note: Rename only updates the path, not the title. Use AddRecord if
// the title changed alongside the path.
func (r *Registry) Rename(id uuid.UUID, newRelPath string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.byID[id]; ok {
		r.byID[id] = newRelPath

		for key, recs := range r.byTitle {
			for i := range recs {
				if recs[i].ID == id {
					r.byTitle[key][i].Path = newRelPath
				}
			}
		}
	}
}

// Hydrate replaces the entire id → path map atomically with the given
// summaries. Used by the composition root at startup after the incremental
// reindex so the in-memory registry reflects every indexed note.
//
// Note: Hydrate does NOT populate the title index. Use HydrateRecords
// to populate both maps from NoteRecords.
func (r *Registry) Hydrate(summaries []NoteSummary) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.byID = make(map[uuid.UUID]string, len(summaries))
	for _, s := range summaries {
		r.byID[s.ID] = s.Path
	}

	r.byTitle = make(map[string][]NoteRecord)
}

// HydrateRecords replaces both the id→path map and the title index
// atomically from the given NoteRecords. Called by the composition root
// at startup after reconcile completes, so the title→records lookup
// reflects every indexed note.
//
// The Title field in each record must already be NFC-normalized and
// lowercase. The indexer guarantees this via ExtractTitle.
func (r *Registry) HydrateRecords(records []NoteRecord) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.byID = make(map[uuid.UUID]string, len(records))
	r.byTitle = make(map[string][]NoteRecord, len(records))
	for _, rec := range records {
		r.byID[rec.ID] = rec.Path
		key := titleKey(rec.Title)
		r.byTitle[key] = append(r.byTitle[key], rec)
	}
}

// FindByTitle returns every note whose title (NFC + lowercase) equals
// titleLower. Results sorted same-folder-first (in alphabetical order by
// path), then all others alphabetically. Pass "" for sourceFolder to skip
// the same-folder bias.
//
// The caller must normalize titleLower to NFC + lowercase before calling
// (the registry does a final NFC normalization on the key, so the lookup
// is robust to NFD input).
//
// Returns a non-nil empty slice (not nil) when no matches are found, so
// callers can distinguish "zero results" from "not queried yet".
func (r *Registry) FindByTitle(titleLower, sourceFolder string) []NoteRecord {
	key := titleKey(titleLower)

	r.mu.RLock()
	candidates := r.byTitle[key]

	out := make([]NoteRecord, len(candidates))
	copy(out, candidates)
	r.mu.RUnlock()

	sort.SliceStable(out, func(i, j int) bool {
		iSame := sourceFolder != "" && isSameFolder(out[i].Path, sourceFolder)
		jSame := sourceFolder != "" && isSameFolder(out[j].Path, sourceFolder)
		if iSame != jSame {
			return iSame
		}

		return out[i].Path < out[j].Path
	})

	return out
}

func (r *Registry) idsUnder(folderPath string) []uuid.UUID {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []uuid.UUID
	prefix := folderPath + "/"
	for id, p := range r.byID {
		if p == folderPath || strings.HasPrefix(p, prefix) {
			out = append(out, id)
		}
	}
	return out
}

func (r *Registry) renamePrefix(oldPrefix, newPrefix string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, p := range r.byID {
		if strings.HasPrefix(p, oldPrefix) {
			r.byID[id] = newPrefix + strings.TrimPrefix(p, oldPrefix)
		}
	}

	for key, recs := range r.byTitle {
		for i := range recs {
			if strings.HasPrefix(recs[i].Path, oldPrefix) {
				r.byTitle[key][i].Path = newPrefix + strings.TrimPrefix(recs[i].Path, oldPrefix)
			}
		}
	}
}

func titleKey(s string) string {
	return strings.ToLower(norm.NFC.String(s))
}

func isSameFolder(notePath, sourceFolder string) bool {
	return filepath.Dir(notePath) == sourceFolder
}

func (r *Registry) removeTitleEntryLocked(id uuid.UUID) {
	for key, recs := range r.byTitle {
		newRecs := recs[:0]
		for _, rec := range recs {
			if rec.ID != id {
				newRecs = append(newRecs, rec)
			}
		}
		if len(newRecs) == 0 {
			delete(r.byTitle, key)
		} else {
			r.byTitle[key] = newRecs
		}
	}
}
