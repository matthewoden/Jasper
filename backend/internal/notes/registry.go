package notes

import (
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
