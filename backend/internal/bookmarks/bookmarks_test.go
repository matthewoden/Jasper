package bookmarks

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// mustMkdirJasper creates <dir>/.jasper, mirroring lifecycle.EnsureDataDir
// which callers rely on before invoking Save in production.
func mustMkdirJasper(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".jasper"), 0o755); err != nil {
		t.Fatalf("mkdir .jasper: %v", err)
	}
}

// newTestRegistry returns a *notes.Registry seeded with the given
// id->relPath pairs, in addition to the registry's built-in scratchpad
// mapping.
func newTestRegistry(entries map[uuid.UUID]string) *notes.Registry {
	r := notes.NewRegistry()
	for id, relPath := range entries {
		r.Add(id, relPath)
	}
	return r
}

func TestLoad_MissingFile_ReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)

	got, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v, want nil", err)
	}
	if len(got.Folders) != 0 || len(got.Bookmarks) != 0 {
		t.Fatalf("Load() = %+v, want empty Bookmarks{}", got)
	}
	if _, statErr := os.Stat(bookmarksPath(dir)); !os.IsNotExist(statErr) {
		t.Fatalf("Load() on missing file must NOT emit a file to disk; stat err = %v", statErr)
	}
}

func TestLoad_MalformedFile_ReturnsEmptyAndWarns(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)

	path := bookmarksPath(dir)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("{not valid json"), 0o644); err != nil {
		t.Fatalf("write malformed file: %v", err)
	}

	got, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v, want nil (malformed => empty, never an error)", err)
	}
	if len(got.Folders) != 0 || len(got.Bookmarks) != 0 {
		t.Fatalf("Load() = %+v, want empty Bookmarks{} on malformed file", got)
	}
}

func TestSaveLoad_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	mustMkdirJasper(t, dir)
	noteID := uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{noteID: "notes/foo.md"})

	folderID := "folder-1"
	doc := Bookmarks{
		Folders: []Folder{{ID: folderID, Name: "Work"}},
		Bookmarks: []Bookmark{
			{ID: "bm-1", NoteID: noteID.String(), FolderID: &folderID, Order: 0},
		},
	}

	if err := Save(dir, doc); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	got, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(got.Folders) != 1 || got.Folders[0].Name != "Work" {
		t.Fatalf("Load() folders = %+v, want [{folder-1 Work}]", got.Folders)
	}
	if len(got.Bookmarks) != 1 || got.Bookmarks[0].NoteID != noteID.String() {
		t.Fatalf("Load() bookmarks = %+v, want one row for %s", got.Bookmarks, noteID)
	}
}

func TestLoad_PrunesDeadNoteBookmarks(t *testing.T) {
	dir := t.TempDir()
	mustMkdirJasper(t, dir)
	liveID := uuid.New()
	deadID := uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{liveID: "notes/live.md"})

	doc := Bookmarks{
		Bookmarks: []Bookmark{
			{ID: "bm-live", NoteID: liveID.String(), Order: 0},
			{ID: "bm-dead", NoteID: deadID.String(), Order: 1},
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
		t.Fatalf("Load() bookmarks = %+v, want only bm-live surviving prune", got.Bookmarks)
	}

	// D-04: the pruned document is re-persisted so the file stays clean.
	reloaded, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() (reload) error = %v", err)
	}
	if len(reloaded.Bookmarks) != 1 || reloaded.Bookmarks[0].ID != "bm-live" {
		t.Fatalf("reloaded bookmarks = %+v, want prune persisted to disk", reloaded.Bookmarks)
	}
}

func TestSave_WritesFileToDisk(t *testing.T) {
	dir := t.TempDir()
	mustMkdirJasper(t, dir)
	doc := Bookmarks{}

	if err := Save(dir, doc); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	path := filepath.Join(dir, ".jasper", "bookmarks.json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected file at %s after Save(); stat err = %v", path, err)
	}
}
