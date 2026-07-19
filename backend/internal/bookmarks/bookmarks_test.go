package bookmarks

import (
	"context"
	"errors"
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

// --- Service ---

type fakeBroadcaster struct {
	calls []string
}

func (f *fakeBroadcaster) Broadcast(event string, _ any, _ string) {
	f.calls = append(f.calls, event)
}

func newTestService(t *testing.T, dir string, registry *notes.Registry, bc notes.Broadcaster) *Service {
	t.Helper()
	mustMkdirJasper(t, dir)
	return New(dir, registry, bc, testLogger())
}

func TestService_Add_CreatesBookmarkAndBroadcasts(t *testing.T) {
	dir := t.TempDir()
	noteID := uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{noteID: "notes/foo.md"})
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	bm, err := svc.Add(context.Background(), noteID, nil)
	if err != nil {
		t.Fatalf("Add() error = %v", err)
	}
	if bm.NoteID != noteID.String() {
		t.Fatalf("Add() bookmark.NoteID = %s, want %s", bm.NoteID, noteID)
	}
	if bm.Order != 0 {
		t.Fatalf("Add() bookmark.Order = %d, want 0", bm.Order)
	}
	if len(bc.calls) != 1 || bc.calls[0] != EventBookmarkChanged {
		t.Fatalf("Add() broadcast calls = %v, want exactly one %s", bc.calls, EventBookmarkChanged)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(doc.Bookmarks) != 1 {
		t.Fatalf("Load() bookmarks = %+v, want persisted Add", doc.Bookmarks)
	}
}

func TestService_Add_UnregisteredNoteID_RejectsAndDoesNotPersist(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	unknownID := uuid.New()
	_, err := svc.Add(context.Background(), unknownID, nil)
	if !errors.Is(err, ErrNoteNotFound) {
		t.Fatalf("Add() error = %v, want ErrNoteNotFound", err)
	}
	if len(bc.calls) != 0 {
		t.Fatalf("Add() broadcast calls = %v, want none on rejection", bc.calls)
	}
	if _, statErr := os.Stat(bookmarksPath(dir)); !os.IsNotExist(statErr) {
		t.Fatalf("Add() with unregistered noteId must NOT persist a file; stat err = %v", statErr)
	}
}

func TestService_Add_UnknownFolderID_RejectsWithErrFolderNotFound(t *testing.T) {
	dir := t.TempDir()
	noteID := uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{noteID: "notes/foo.md"})
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	bogus := "does-not-exist"
	_, err := svc.Add(context.Background(), noteID, &bogus)
	if !errors.Is(err, ErrFolderNotFound) {
		t.Fatalf("Add() error = %v, want ErrFolderNotFound", err)
	}
	if len(bc.calls) != 0 {
		t.Fatalf("Add() broadcast calls = %v, want none on rejection", bc.calls)
	}
}

func TestService_Remove_DropsRowAndBroadcasts(t *testing.T) {
	dir := t.TempDir()
	noteID := uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{noteID: "notes/foo.md"})
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	bm, err := svc.Add(context.Background(), noteID, nil)
	if err != nil {
		t.Fatalf("Add() error = %v", err)
	}
	bc.calls = nil // reset — only assert on Remove's broadcast

	if err := svc.Remove(context.Background(), bm.ID); err != nil {
		t.Fatalf("Remove() error = %v", err)
	}
	if len(bc.calls) != 1 || bc.calls[0] != EventBookmarkChanged {
		t.Fatalf("Remove() broadcast calls = %v, want exactly one %s", bc.calls, EventBookmarkChanged)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(doc.Bookmarks) != 0 {
		t.Fatalf("Load() bookmarks = %+v, want empty after Remove", doc.Bookmarks)
	}
}

func TestService_Remove_UnknownID_ReturnsErrNotFound(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	err := svc.Remove(context.Background(), "does-not-exist")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("Remove() error = %v, want ErrNotFound", err)
	}
	if len(bc.calls) != 0 {
		t.Fatalf("Remove() broadcast calls = %v, want none on rejection", bc.calls)
	}
}

func TestService_MoveToFolder_SetsFolderIDAndBroadcasts(t *testing.T) {
	dir := t.TempDir()
	noteID := uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{noteID: "notes/foo.md"})
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	bm, err := svc.Add(context.Background(), noteID, nil)
	if err != nil {
		t.Fatalf("Add() error = %v", err)
	}
	folder, err := svc.CreateFolder(context.Background(), "Work")
	if err != nil {
		t.Fatalf("CreateFolder() error = %v", err)
	}
	bc.calls = nil

	if err := svc.MoveToFolder(context.Background(), bm.ID, &folder.ID); err != nil {
		t.Fatalf("MoveToFolder() error = %v", err)
	}
	if len(bc.calls) != 1 || bc.calls[0] != EventBookmarkChanged {
		t.Fatalf("MoveToFolder() broadcast calls = %v, want exactly one %s", bc.calls, EventBookmarkChanged)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(doc.Bookmarks) != 1 || doc.Bookmarks[0].FolderID == nil || *doc.Bookmarks[0].FolderID != folder.ID {
		t.Fatalf("Load() bookmarks = %+v, want FolderID = %s", doc.Bookmarks, folder.ID)
	}

	// Moving back to top level: nil folderID.
	if err := svc.MoveToFolder(context.Background(), bm.ID, nil); err != nil {
		t.Fatalf("MoveToFolder(nil) error = %v", err)
	}
	doc, err = Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if doc.Bookmarks[0].FolderID != nil {
		t.Fatalf("Load() bookmarks[0].FolderID = %v, want nil after top-level move", doc.Bookmarks[0].FolderID)
	}
}

func TestService_MoveToFolder_UnknownBookmarkID_ReturnsErrNotFound(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	err := svc.MoveToFolder(context.Background(), "does-not-exist", nil)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("MoveToFolder() error = %v, want ErrNotFound", err)
	}
}

func TestService_MoveToFolder_UnknownFolderID_ReturnsErrFolderNotFound(t *testing.T) {
	dir := t.TempDir()
	noteID := uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{noteID: "notes/foo.md"})
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	bm, err := svc.Add(context.Background(), noteID, nil)
	if err != nil {
		t.Fatalf("Add() error = %v", err)
	}
	bogus := "does-not-exist"
	err = svc.MoveToFolder(context.Background(), bm.ID, &bogus)
	if !errors.Is(err, ErrFolderNotFound) {
		t.Fatalf("MoveToFolder() error = %v, want ErrFolderNotFound", err)
	}
}

func TestService_CreateFolder_AppendsAndBroadcasts(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	f, err := svc.CreateFolder(context.Background(), "Work")
	if err != nil {
		t.Fatalf("CreateFolder() error = %v", err)
	}
	if f.Name != "Work" || f.ID == "" {
		t.Fatalf("CreateFolder() = %+v, want non-empty ID and Name=Work", f)
	}
	if len(bc.calls) != 1 || bc.calls[0] != EventBookmarkChanged {
		t.Fatalf("CreateFolder() broadcast calls = %v, want exactly one %s", bc.calls, EventBookmarkChanged)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(doc.Folders) != 1 {
		t.Fatalf("Load() folders = %+v, want persisted CreateFolder", doc.Folders)
	}
}

func TestService_CreateFolder_EmptyName_ReturnsErrInvalidName(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	for _, name := range []string{"", "   ", "\t\n"} {
		_, err := svc.CreateFolder(context.Background(), name)
		if !errors.Is(err, ErrInvalidName) {
			t.Fatalf("CreateFolder(%q) error = %v, want ErrInvalidName", name, err)
		}
	}
	if len(bc.calls) != 0 {
		t.Fatalf("CreateFolder() broadcast calls = %v, want none on rejection", bc.calls)
	}
}
