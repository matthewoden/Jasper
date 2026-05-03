package notes

import (
	"strings"
	"sync"

	"github.com/google/uuid"
)

// ScratchpadUUID is the hard-coded UUID for Phase 1's single note.
// Per CONTEXT.md D-06 and the example in api/openapi.yaml. Phase 3 will
// replace this with real per-note UUIDs from the SQLite index.
var ScratchpadUUID = uuid.MustParse("00000000-0000-4000-a000-000000000001")

// ScratchpadRelPath is the canonical relative path under notes/ for the
// Phase 1 scratchpad. Per CONTEXT.md D-08.
const ScratchpadRelPath = "scratchpad.md"

// ScratchpadWelcome is the seed content written to scratchpad.md if the
// file does not exist on first server start. Locked verbatim by the
// 01-UI-SPEC.md "Welcome template — line-by-line content as plain text"
// section. ~290 bytes including the trailing newline.
//
// The exact bytes matter: this is what the user sees when they open
// Jasper for the first time. Do NOT paraphrase. The em-dash and ⌘ symbol
// are intentional (Mac-first per PROJECT). The path inside the backticks
// is the default vault root (D-07).
const ScratchpadWelcome = "# Welcome to Jasper\n" +
	"\n" +
	"This is your scratchpad. Edit anything — your changes save automatically a moment after you stop typing, or immediately when you press ⌘S.\n" +
	"\n" +
	"This file lives at `~/.jasper/notes/scratchpad.md`. Open it with any editor; it's just markdown.\n"

// Registry maps UUIDs to canonical relative paths. Phase 1 has exactly
// one entry; the type is generalized so Phase 3 can replace this with
// a SQLite-backed lookup without changing notes.Service.
type Registry struct {
	mu   sync.RWMutex
	byID map[uuid.UUID]string
}

// NewRegistry returns a Registry seeded with the Phase 1 scratchpad mapping.
func NewRegistry() *Registry {
	return &Registry{
		byID: map[uuid.UUID]string{
			ScratchpadUUID: ScratchpadRelPath,
		},
	}
}

// Lookup returns the canonical relPath for a UUID, or "", false if unknown.
func (r *Registry) Lookup(id uuid.UUID) (string, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	relPath, ok := r.byID[id]
	return relPath, ok
}

// Add inserts (or overwrites) the id → relPath mapping. Phase 3 Plan
// 03-03 addition — called by Service.Create after the file write +
// index upsert succeed. Idempotent: re-Adding the same id replaces the
// path in place.
func (r *Registry) Add(id uuid.UUID, relPath string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.byID[id] = relPath
}

// Remove deletes the mapping for id. Idempotent — removing an absent id
// is a no-op (the registry can be ahead/behind reality during reconcile).
// Phase 3 Plan 03-03 addition — called by Service.Delete after a
// successful FS delete.
func (r *Registry) Remove(id uuid.UUID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.byID, id)
}

// Rename updates the relPath for id IF the id is already present.
// Insert-on-rename is intentionally NOT supported: Service.Move is the
// only caller and it always calls Add → Rename → ... never Rename for
// a fresh id. Phase 3 Plan 03-03 addition.
func (r *Registry) Rename(id uuid.UUID, newRelPath string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.byID[id]; ok {
		r.byID[id] = newRelPath
	}
}

// Hydrate replaces the entire id → path map atomically with the given
// summaries. Used by the composition root (Plan 03-04) at startup AFTER
// the incremental reindex so the in-memory registry reflects every
// indexed note. The ScratchpadUUID is included in summaries because
// chooseID assigns it when the scratchpad.md path is walked. Phase 3
// Plan 03-03 addition.
func (r *Registry) Hydrate(summaries []NoteSummary) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.byID = make(map[uuid.UUID]string, len(summaries))
	for _, s := range summaries {
		r.byID[s.ID] = s.Path
	}
}

// idsUnder returns the ids of every entry whose relPath is the bare
// folder path or starts with `<folderPath>/`. Used by Service.DeleteFolder
// to remove every doomed registry entry after a recursive FS rmtree.
// Package-private — exposed only to Service.
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

// renamePrefix re-prefixes every entry whose relPath starts with
// oldPrefix to start with newPrefix. Both prefixes MUST end with "/"
// (or be empty). Used by Service.MoveFolder after a successful FS+index
// move. Package-private.
func (r *Registry) renamePrefix(oldPrefix, newPrefix string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, p := range r.byID {
		if strings.HasPrefix(p, oldPrefix) {
			r.byID[id] = newPrefix + strings.TrimPrefix(p, oldPrefix)
		}
	}
}
