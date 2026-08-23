package workspace

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
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

func TestLoad_MissingFile_ReturnsDefaults(t *testing.T) {
	dir := t.TempDir()

	got, err := Load(dir, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v, want nil", err)
	}
	if got != (Workspace{}) {
		t.Fatalf("Load() = %+v, want zero-value Workspace{}", got)
	}
	if _, statErr := os.Stat(workspacePath(dir)); !os.IsNotExist(statErr) {
		t.Fatalf("Load() on missing file must NOT emit a file to disk; stat err = %v", statErr)
	}
}

func TestLoad_MalformedFile_ReturnsDefaultsAndWarns(t *testing.T) {
	dir := t.TempDir()
	mustMkdirJasper(t, dir)

	path := workspacePath(dir)
	if err := os.WriteFile(path, []byte("{not valid json"), 0o644); err != nil {
		t.Fatalf("write malformed file: %v", err)
	}

	got, err := Load(dir, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v, want nil (malformed => defaults, never an error)", err)
	}
	if got != (Workspace{}) {
		t.Fatalf("Load() = %+v, want zero-value Workspace{} on malformed file", got)
	}
}

func TestLoad_UnknownField_DoesNotError(t *testing.T) {
	dir := t.TempDir()
	mustMkdirJasper(t, dir)

	path := workspacePath(dir)
	raw := `{"notesSort": "name-asc", "searchSort": "relevance", "futureField": "added by a newer Jasper binary"}`
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatalf("write file with unknown field: %v", err)
	}

	got, err := Load(dir, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v, want nil (unknown field must not error)", err)
	}
	if got.NotesSort != "name-asc" || got.SearchSort != "relevance" {
		t.Fatalf("Load() = %+v, want notesSort/searchSort preserved despite unknown field", got)
	}
}

func TestSaveLoad_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	mustMkdirJasper(t, dir)

	doc := Workspace{NotesSort: "modified-desc", SearchSort: "created"}
	if err := Save(dir, doc); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	got, err := Load(dir, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got != doc {
		t.Fatalf("Load() = %+v, want %+v", got, doc)
	}
}

// --- Service ---

type fakeBroadcaster struct {
	calls []string
}

func (f *fakeBroadcaster) Broadcast(event string, _ any, _ string) {
	f.calls = append(f.calls, event)
}

func newTestService(t *testing.T, dir string, bc *fakeBroadcaster) *Service {
	t.Helper()
	mustMkdirJasper(t, dir)
	return New(dir, bc, testLogger())
}

func TestService_SetNotesSort_PersistsAndBroadcastsWithoutTouchingSearchSort(t *testing.T) {
	dir := t.TempDir()
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, bc)

	// Seed SearchSort via SetSearchSort first, to prove SetNotesSort leaves
	// it untouched.
	if _, err := svc.SetSearchSort(context.Background(), "created"); err != nil {
		t.Fatalf("SetSearchSort() error = %v", err)
	}
	bc.calls = nil

	got, err := svc.SetNotesSort(context.Background(), "name-asc")
	if err != nil {
		t.Fatalf("SetNotesSort() error = %v", err)
	}
	if got.NotesSort != "name-asc" {
		t.Fatalf("SetNotesSort() = %+v, want NotesSort = name-asc", got)
	}
	if got.SearchSort != "created" {
		t.Fatalf("SetNotesSort() = %+v, want SearchSort left untouched at created", got)
	}
	if len(bc.calls) != 1 || bc.calls[0] != EventWorkspaceChanged {
		t.Fatalf("SetNotesSort() broadcast calls = %v, want exactly one %s", bc.calls, EventWorkspaceChanged)
	}

	doc, err := Load(dir, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if doc.NotesSort != "name-asc" || doc.SearchSort != "created" {
		t.Fatalf("Load() = %+v, want persisted {name-asc, created}", doc)
	}
}

func TestService_SetSearchSort_PersistsAndBroadcastsWithoutTouchingNotesSort(t *testing.T) {
	dir := t.TempDir()
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, bc)

	if _, err := svc.SetNotesSort(context.Background(), "modified-asc"); err != nil {
		t.Fatalf("SetNotesSort() error = %v", err)
	}
	bc.calls = nil

	got, err := svc.SetSearchSort(context.Background(), "relevance")
	if err != nil {
		t.Fatalf("SetSearchSort() error = %v", err)
	}
	if got.SearchSort != "relevance" {
		t.Fatalf("SetSearchSort() = %+v, want SearchSort = relevance", got)
	}
	if got.NotesSort != "modified-asc" {
		t.Fatalf("SetSearchSort() = %+v, want NotesSort left untouched at modified-asc", got)
	}
	if len(bc.calls) != 1 || bc.calls[0] != EventWorkspaceChanged {
		t.Fatalf("SetSearchSort() broadcast calls = %v, want exactly one %s", bc.calls, EventWorkspaceChanged)
	}

	doc, err := Load(dir, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if doc.NotesSort != "modified-asc" || doc.SearchSort != "relevance" {
		t.Fatalf("Load() = %+v, want persisted {modified-asc, relevance}", doc)
	}
}

func TestService_SetNotesSort_InvalidValue_RejectsWithoutPersisting(t *testing.T) {
	dir := t.TempDir()
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, bc)

	_, err := svc.SetNotesSort(context.Background(), "bogus-sort")
	if !errors.Is(err, ErrInvalidSort) {
		t.Fatalf("SetNotesSort() error = %v, want ErrInvalidSort", err)
	}
	if len(bc.calls) != 0 {
		t.Fatalf("SetNotesSort() broadcast calls = %v, want none on rejection", bc.calls)
	}
	if _, statErr := os.Stat(workspacePath(dir)); !os.IsNotExist(statErr) {
		t.Fatalf("SetNotesSort() with invalid value must NOT persist a file; stat err = %v", statErr)
	}
}

func TestService_SetSearchSort_InvalidValue_RejectsWithoutPersisting(t *testing.T) {
	dir := t.TempDir()
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, bc)

	_, err := svc.SetSearchSort(context.Background(), "bogus-sort")
	if !errors.Is(err, ErrInvalidSort) {
		t.Fatalf("SetSearchSort() error = %v, want ErrInvalidSort", err)
	}
	if len(bc.calls) != 0 {
		t.Fatalf("SetSearchSort() broadcast calls = %v, want none on rejection", bc.calls)
	}
	if _, statErr := os.Stat(workspacePath(dir)); !os.IsNotExist(statErr) {
		t.Fatalf("SetSearchSort() with invalid value must NOT persist a file; stat err = %v", statErr)
	}
}

func TestService_SetBookmarksSort_PersistsAndBroadcastsWithoutTouchingSiblings(t *testing.T) {
	dir := t.TempDir()
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, bc)

	if _, err := svc.SetNotesSort(context.Background(), "modified-asc"); err != nil {
		t.Fatalf("SetNotesSort() error = %v", err)
	}
	bc.calls = nil

	got, err := svc.SetBookmarksSort(context.Background(), "created-desc")
	if err != nil {
		t.Fatalf("SetBookmarksSort() error = %v", err)
	}
	if got.BookmarksSort != "created-desc" {
		t.Fatalf("SetBookmarksSort() = %+v, want BookmarksSort = created-desc", got)
	}
	if got.NotesSort != "modified-asc" {
		t.Fatalf("SetBookmarksSort() = %+v, want NotesSort left untouched at modified-asc", got)
	}
	if len(bc.calls) != 1 || bc.calls[0] != EventWorkspaceChanged {
		t.Fatalf("SetBookmarksSort() broadcast calls = %v, want exactly one %s", bc.calls, EventWorkspaceChanged)
	}

	doc, err := Load(dir, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if doc.BookmarksSort != "created-desc" || doc.NotesSort != "modified-asc" {
		t.Fatalf("Load() = %+v, want persisted {modified-asc, created-desc}", doc)
	}
}

func TestService_SetBookmarksSort_AcceptsManual(t *testing.T) {
	dir := t.TempDir()
	svc := newTestService(t, dir, &fakeBroadcaster{})

	got, err := svc.SetBookmarksSort(context.Background(), "manual")
	if err != nil {
		t.Fatalf("SetBookmarksSort(manual) error = %v, want nil", err)
	}
	if got.BookmarksSort != "manual" {
		t.Fatalf("SetBookmarksSort(manual) = %+v, want manual", got)
	}
}

func TestService_SetBookmarksSort_InvalidValue_RejectsWithoutPersisting(t *testing.T) {
	dir := t.TempDir()
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, bc)

	_, err := svc.SetBookmarksSort(context.Background(), "bogus-sort")
	if !errors.Is(err, ErrInvalidSort) {
		t.Fatalf("SetBookmarksSort() error = %v, want ErrInvalidSort", err)
	}
	if len(bc.calls) != 0 {
		t.Fatalf("SetBookmarksSort() broadcast calls = %v, want none on rejection", bc.calls)
	}
	if _, statErr := os.Stat(workspacePath(dir)); !os.IsNotExist(statErr) {
		t.Fatalf("SetBookmarksSort() with invalid value must NOT persist a file; stat err = %v", statErr)
	}
}

func TestIsValidBookmarksSort(t *testing.T) {
	valid := []string{"", "manual", "name-asc", "name-desc", "modified-desc", "modified-asc", "created-desc", "created-asc"}
	for _, v := range valid {
		if !IsValidBookmarksSort(v) {
			t.Fatalf("IsValidBookmarksSort(%q) = false, want true", v)
		}
	}
	// "relevance" is a searchSort value and must not leak into this enum.
	for _, v := range []string{"relevance", "bogus"} {
		if IsValidBookmarksSort(v) {
			t.Fatalf("IsValidBookmarksSort(%q) = true, want false", v)
		}
	}
}
