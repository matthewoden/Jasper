package bookmarks

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// A full rebuild (POST /admin/reindex, or reset-and-rebuild) DROPs the notes
// table and re-mints every note id, which used to make prune-on-read discard
// every bookmark in the vault and persist the loss.
func TestLoad_ReResolvesByPathAfterIDChange(t *testing.T) {
	dir := t.TempDir()
	mustMkdirJasper(t, dir)

	oldID := uuid.New()
	newID := uuid.New()
	// The rebuild's registry: same path, freshly minted id.
	registry := newTestRegistry(map[uuid.UUID]string{newID: "notes/keep.md"})

	doc := Bookmarks{
		Bookmarks: []Bookmark{
			{ID: "bm-1", NoteID: oldID.String(), Path: "notes/keep.md", Order: 0},
		},
	}
	if err := Save(dir, doc); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	got, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(got.Bookmarks) != 1 {
		t.Fatalf("Load() bookmarks = %+v, want the row to survive the id change", got.Bookmarks)
	}
	if got.Bookmarks[0].NoteID != newID.String() {
		t.Fatalf("Load() NoteID = %s, want adopted %s", got.Bookmarks[0].NoteID, newID)
	}

	// The adoption is persisted, so the next read resolves by id directly.
	reloaded, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() (reload) error = %v", err)
	}
	if len(reloaded.Bookmarks) != 1 || reloaded.Bookmarks[0].NoteID != newID.String() {
		t.Fatalf("reloaded = %+v, want adoption persisted to disk", reloaded.Bookmarks)
	}
}

// A deleted note must still prune: the path hint is a fallback, not a way for
// a dead bookmark to linger.
func TestLoad_PrunesWhenPathIsAlsoGone(t *testing.T) {
	dir := t.TempDir()
	mustMkdirJasper(t, dir)

	liveID := uuid.New()
	deadID := uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{liveID: "notes/live.md"})

	doc := Bookmarks{
		Bookmarks: []Bookmark{
			{ID: "bm-live", NoteID: liveID.String(), Path: "notes/live.md", Order: 0},
			{ID: "bm-dead", NoteID: deadID.String(), Path: "notes/deleted.md", Order: 1},
		},
	}
	if err := Save(dir, doc); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	got, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(got.Bookmarks) != 1 || got.Bookmarks[0].ID != "bm-live" {
		t.Fatalf("Load() bookmarks = %+v, want only bm-live", got.Bookmarks)
	}
}

// Rename moves the note without changing its id, so the row survives on the
// id — but the hint has to follow, or a later rebuild resolves a path the note
// has left and the bookmark dies anyway.
func TestLoad_RefreshesStalePathHint(t *testing.T) {
	dir := t.TempDir()
	mustMkdirJasper(t, dir)

	noteID := uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{noteID: "notes/renamed.md"})

	doc := Bookmarks{
		Bookmarks: []Bookmark{
			{ID: "bm-1", NoteID: noteID.String(), Path: "notes/original.md", Order: 0},
		},
	}
	if err := Save(dir, doc); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	got, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(got.Bookmarks) != 1 || got.Bookmarks[0].Path != "notes/renamed.md" {
		t.Fatalf("Load() bookmarks = %+v, want Path refreshed to notes/renamed.md", got.Bookmarks)
	}

	// Refreshed on disk too: prove it by rebuilding identity under the new
	// path and checking the row is still recoverable.
	rebuilt := uuid.New()
	rebuiltRegistry := newTestRegistry(map[uuid.UUID]string{rebuilt: "notes/renamed.md"})
	after, err := Load(dir, rebuiltRegistry, testLogger())
	if err != nil {
		t.Fatalf("Load() (after rebuild) error = %v", err)
	}
	if len(after.Bookmarks) != 1 || after.Bookmarks[0].NoteID != rebuilt.String() {
		t.Fatalf("after rebuild = %+v, want the refreshed hint to recover the row", after.Bookmarks)
	}
}

// A row written before Path existed carries no hint and cannot be recovered;
// it must prune rather than survive unresolved.
func TestLoad_PrunesRowWithNoPathHint(t *testing.T) {
	dir := t.TempDir()
	mustMkdirJasper(t, dir)

	deadID := uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{uuid.New(): "notes/other.md"})

	doc := Bookmarks{
		Bookmarks: []Bookmark{{ID: "bm-legacy", NoteID: deadID.String(), Order: 0}},
	}
	if err := Save(dir, doc); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	got, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(got.Bookmarks) != 0 {
		t.Fatalf("Load() bookmarks = %+v, want the hintless row pruned", got.Bookmarks)
	}
}

func TestService_Add_RecordsPathHint(t *testing.T) {
	dir := t.TempDir()
	noteID := uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{noteID: "notes/foo.md"})
	svc := newTestService(t, dir, registry, &fakeBroadcaster{})

	bm, err := svc.Add(context.Background(), noteID, nil)
	if err != nil {
		t.Fatalf("Add() error = %v", err)
	}
	if bm.Path != "notes/foo.md" {
		t.Fatalf("Add() bookmark.Path = %q, want notes/foo.md", bm.Path)
	}

	persisted, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(persisted.Bookmarks) != 1 || persisted.Bookmarks[0].Path != "notes/foo.md" {
		t.Fatalf("persisted = %+v, want the hint written to disk", persisted.Bookmarks)
	}
}
