package bookmarks

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
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

// TestLoad_UnknownField_RoundTripsWithoutDataLoss: a
// well-formed bookmarks.json carrying an extra/unrecognized field (e.g.
// written by a newer binary, or hand-edited) must NOT be treated the same
// as corrupt JSON. Before the fix, DisallowUnknownFields() rejected this
// file, Load fell back to Bookmarks{}, and the next mutation's Save would
// have permanently overwritten the file with that empty document —
// silently destroying every bookmark and folder.
func TestLoad_UnknownField_RoundTripsWithoutDataLoss(t *testing.T) {
	dir := t.TempDir()
	mustMkdirJasper(t, dir)
	noteID := uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{noteID: "notes/foo.md"})

	path := bookmarksPath(dir)
	raw := `{
		"folders": [],
		"bookmarks": [{"id": "bm-1", "noteId": "` + noteID.String() + `", "folderId": null, "order": 0}],
		"futureField": "added by a newer Jasper binary"
	}`
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatalf("write file with unknown field: %v", err)
	}

	got, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v, want nil (unknown field must not error)", err)
	}
	if len(got.Bookmarks) != 1 || got.Bookmarks[0].ID != "bm-1" {
		t.Fatalf("Load() bookmarks = %+v, want the pre-existing bookmark preserved, not wiped", got.Bookmarks)
	}

	// The bug manifested on the NEXT write: confirm a mutation-triggered
	// Save does not clobber the file with an empty document.
	if err := Save(dir, got); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	reloaded, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() (reload) error = %v", err)
	}
	if len(reloaded.Bookmarks) != 1 || reloaded.Bookmarks[0].ID != "bm-1" {
		t.Fatalf("reloaded bookmarks = %+v, want bookmark still present after Save round-trip", reloaded.Bookmarks)
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

	// The pruned document is re-persisted so the file stays clean.
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

// TestService_Order_RenumberedAcrossFoldersOnMove guards the
// MoveToFolder path: moving a bookmark out of a folder must close the
// gap it leaves behind (source folder renumbered), and moving it in must
// not carry over its old, now-meaningless Order value (destination
// folder renumbered too).
func TestService_Order_RenumberedAcrossFoldersOnMove(t *testing.T) {
	dir := t.TempDir()
	noteA, noteB, noteC := uuid.New(), uuid.New(), uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{
		noteA: "notes/a.md", noteB: "notes/b.md", noteC: "notes/c.md",
	})
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	folder, err := svc.CreateFolder(context.Background(), "Work")
	if err != nil {
		t.Fatalf("CreateFolder() error = %v", err)
	}

	bmA, err := svc.Add(context.Background(), noteA, nil) // top-level, Order 0
	if err != nil {
		t.Fatalf("Add(A) error = %v", err)
	}
	if _, err := svc.Add(context.Background(), noteB, nil); err != nil { // top-level, Order 1
		t.Fatalf("Add(B) error = %v", err)
	}
	bmC, err := svc.Add(context.Background(), noteC, &folder.ID) // in folder, Order 0
	if err != nil {
		t.Fatalf("Add(C) error = %v", err)
	}
	if bmC.Order != 0 {
		t.Fatalf("bmC.Order = %d, want 0 (first bookmark in folder)", bmC.Order)
	}

	// Move A from top-level into the folder: top-level should close its
	// gap (B renumbered 1->0), and the folder should gain A alongside C
	// without either sharing an Order value.
	if err := svc.MoveToFolder(context.Background(), bmA.ID, &folder.ID); err != nil {
		t.Fatalf("MoveToFolder(A) error = %v", err)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	topLevelOrders := map[int]bool{}
	folderOrders := map[int]bool{}
	for _, bm := range doc.Bookmarks {
		if bm.FolderID == nil {
			if topLevelOrders[bm.Order] {
				t.Fatalf("Load() bookmarks = %+v, want no duplicate top-level Order", doc.Bookmarks)
			}
			topLevelOrders[bm.Order] = true
		} else {
			if folderOrders[bm.Order] {
				t.Fatalf("Load() bookmarks = %+v, want no duplicate in-folder Order", doc.Bookmarks)
			}
			folderOrders[bm.Order] = true
		}
	}
	if len(topLevelOrders) != 1 || !topLevelOrders[0] {
		t.Fatalf("top-level orders = %v, want exactly {0} (B renumbered after A moved out)", topLevelOrders)
	}
	if len(folderOrders) != 2 {
		t.Fatalf("folder orders = %v, want 2 distinct values (C and moved-in A)", folderOrders)
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

// TestService_Add_ConcurrentCallsDoNotLoseUpdates: without a
// mutex serializing Load->mutate->Save, two concurrent Add calls can both
// Load the same pre-mutation document and one Save clobbers the other's
// bookmark row. With the fix, all N concurrent adds must survive.
func TestService_Add_ConcurrentCallsDoNotLoseUpdates(t *testing.T) {
	dir := t.TempDir()
	const n = 20
	noteIDs := make([]uuid.UUID, n)
	entries := make(map[uuid.UUID]string, n)
	for i := range noteIDs {
		id := uuid.New()
		noteIDs[i] = id
		entries[id] = "notes/concurrent.md"
	}
	registry := newTestRegistry(entries)
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	var wg sync.WaitGroup
	wg.Add(n)
	for _, id := range noteIDs {
		go func(id uuid.UUID) {
			defer wg.Done()
			if _, err := svc.Add(context.Background(), id, nil); err != nil {
				t.Errorf("Add(%s) error = %v", id, err)
			}
		}(id)
	}
	wg.Wait()

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(doc.Bookmarks) != n {
		t.Fatalf("Load() bookmarks = %d rows, want %d (a race lost at least one concurrent Add)", len(doc.Bookmarks), n)
	}
}

// TestService_Order_ScopedPerFolderNotGlobal: Order must be
// computed per-folder, not as a global count across every bookmark. A
// top-level Add and a same-moment in-folder Add must each independently
// start at Order 0.
func TestService_Order_ScopedPerFolderNotGlobal(t *testing.T) {
	dir := t.TempDir()
	noteA := uuid.New()
	noteB := uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{
		noteA: "notes/a.md",
		noteB: "notes/b.md",
	})
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	folder, err := svc.CreateFolder(context.Background(), "Work")
	if err != nil {
		t.Fatalf("CreateFolder() error = %v", err)
	}

	bmA, err := svc.Add(context.Background(), noteA, nil)
	if err != nil {
		t.Fatalf("Add(A, top-level) error = %v", err)
	}
	if bmA.Order != 0 {
		t.Fatalf("bmA.Order = %d, want 0 (first top-level bookmark)", bmA.Order)
	}

	bmB, err := svc.Add(context.Background(), noteB, &folder.ID)
	if err != nil {
		t.Fatalf("Add(B, in folder) error = %v", err)
	}
	if bmB.Order != 0 {
		t.Fatalf("bmB.Order = %d, want 0 (per-folder scope, not a global count across bmA)", bmB.Order)
	}
}

// TestService_Order_RenumberedOnRemove: after removing an
// earlier sibling, the remaining bookmarks in that folder must be
// renumbered contiguously so a subsequent Add never collides with an
// existing Order value.
func TestService_Order_RenumberedOnRemove(t *testing.T) {
	dir := t.TempDir()
	noteA, noteB, noteC, noteD := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{
		noteA: "notes/a.md", noteB: "notes/b.md", noteC: "notes/c.md", noteD: "notes/d.md",
	})
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	bmA, err := svc.Add(context.Background(), noteA, nil)
	if err != nil {
		t.Fatalf("Add(A) error = %v", err)
	}
	if _, err := svc.Add(context.Background(), noteB, nil); err != nil {
		t.Fatalf("Add(B) error = %v", err)
	}
	if _, err := svc.Add(context.Background(), noteC, nil); err != nil {
		t.Fatalf("Add(C) error = %v", err)
	}
	// A(0), B(1), C(2).

	if err := svc.Remove(context.Background(), bmA.ID); err != nil {
		t.Fatalf("Remove(A) error = %v", err)
	}
	// Without renumbering: B stays 1, C stays 2 (a stale gap at 0).

	bmD, err := svc.Add(context.Background(), noteD, nil)
	if err != nil {
		t.Fatalf("Add(D) error = %v", err)
	}
	// Before the per-folder-order fix: len(doc.Bookmarks) == 2 at this point, so D
	// would get Order 2, colliding with C's stale Order 2.
	if bmD.Order != 2 {
		t.Fatalf("bmD.Order = %d, want 2 (B and C must have been renumbered to 0,1 on Remove)", bmD.Order)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	seen := map[int]bool{}
	for _, bm := range doc.Bookmarks {
		if seen[bm.Order] {
			t.Fatalf("Load() bookmarks = %+v, want no duplicate Order values", doc.Bookmarks)
		}
		seen[bm.Order] = true
	}
	if len(seen) != 3 {
		t.Fatalf("Load() bookmarks = %+v, want 3 distinct Order values (0,1,2)", doc.Bookmarks)
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

// TestService_Reorder_PersistsExplicitOrderWithinTopLevel guards the
// Task-1 reorder endpoint's happy path: an explicit ordered_ids list for
// the top-level scope (folderID == nil) is assigned Order = index and
// persisted, and a subsequent Load reflects it.
func TestService_Reorder_PersistsExplicitOrderWithinTopLevel(t *testing.T) {
	dir := t.TempDir()
	noteA, noteB, noteC := uuid.New(), uuid.New(), uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{
		noteA: "notes/a.md", noteB: "notes/b.md", noteC: "notes/c.md",
	})
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	bmA, err := svc.Add(context.Background(), noteA, nil)
	if err != nil {
		t.Fatalf("Add(A) error = %v", err)
	}
	bmB, err := svc.Add(context.Background(), noteB, nil)
	if err != nil {
		t.Fatalf("Add(B) error = %v", err)
	}
	bmC, err := svc.Add(context.Background(), noteC, nil)
	if err != nil {
		t.Fatalf("Add(C) error = %v", err)
	}
	// A(0), B(1), C(2) by append order.
	bc.calls = nil

	if err := svc.Reorder(context.Background(), nil, []string{bmC.ID, bmA.ID, bmB.ID}); err != nil {
		t.Fatalf("Reorder() error = %v", err)
	}
	if len(bc.calls) != 1 || bc.calls[0] != EventBookmarkChanged {
		t.Fatalf("Reorder() broadcast calls = %v, want exactly one %s", bc.calls, EventBookmarkChanged)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	orders := map[string]int{}
	for _, bm := range doc.Bookmarks {
		orders[bm.ID] = bm.Order
	}
	if orders[bmC.ID] != 0 || orders[bmA.ID] != 1 || orders[bmB.ID] != 2 {
		t.Fatalf("orders = %+v, want C=0, A=1, B=2", orders)
	}
}

// TestService_Reorder_WithinFolderScope guards a non-nil folder scope.
func TestService_Reorder_WithinFolderScope(t *testing.T) {
	dir := t.TempDir()
	noteA, noteB := uuid.New(), uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{
		noteA: "notes/a.md", noteB: "notes/b.md",
	})
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	folder, err := svc.CreateFolder(context.Background(), "Work")
	if err != nil {
		t.Fatalf("CreateFolder() error = %v", err)
	}
	bmA, err := svc.Add(context.Background(), noteA, &folder.ID)
	if err != nil {
		t.Fatalf("Add(A) error = %v", err)
	}
	bmB, err := svc.Add(context.Background(), noteB, &folder.ID)
	if err != nil {
		t.Fatalf("Add(B) error = %v", err)
	}

	if err := svc.Reorder(context.Background(), &folder.ID, []string{bmB.ID, bmA.ID}); err != nil {
		t.Fatalf("Reorder() error = %v", err)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	orders := map[string]int{}
	for _, bm := range doc.Bookmarks {
		orders[bm.ID] = bm.Order
	}
	if orders[bmB.ID] != 0 || orders[bmA.ID] != 1 {
		t.Fatalf("orders = %+v, want B=0, A=1", orders)
	}
}

// TestService_Reorder_MembershipMismatch_ReturnsErrNotFoundNoWrite guards
// An ordered_ids set that is missing a member, includes a
// foreign id, or both, is rejected wholesale (no partial write) with
// ErrNotFound.
func TestService_Reorder_MembershipMismatch_ReturnsErrNotFoundNoWrite(t *testing.T) {
	dir := t.TempDir()
	noteA, noteB := uuid.New(), uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{
		noteA: "notes/a.md", noteB: "notes/b.md",
	})
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	bmA, err := svc.Add(context.Background(), noteA, nil)
	if err != nil {
		t.Fatalf("Add(A) error = %v", err)
	}
	bmB, err := svc.Add(context.Background(), noteB, nil)
	if err != nil {
		t.Fatalf("Add(B) error = %v", err)
	}
	bc.calls = nil

	cases := [][]string{
		{bmA.ID},                      // missing B
		{bmA.ID, bmB.ID, "forged-id"}, // extra foreign id
		{"forged-id"},                 // wholly foreign
	}
	for _, orderedIDs := range cases {
		err := svc.Reorder(context.Background(), nil, orderedIDs)
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("Reorder(%v) error = %v, want ErrNotFound", orderedIDs, err)
		}
	}
	if len(bc.calls) != 0 {
		t.Fatalf("Reorder() broadcast calls = %v, want none on rejection", bc.calls)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	orders := map[string]int{}
	for _, bm := range doc.Bookmarks {
		orders[bm.ID] = bm.Order
	}
	if orders[bmA.ID] != 0 || orders[bmB.ID] != 1 {
		t.Fatalf("orders = %+v, want unchanged A=0, B=1 (no partial write on rejection)", orders)
	}
}

// TestService_Reorder_UnknownFolderID_ReturnsErrFolderNotFound guards
// an unknown folder_id is rejected with 400.
func TestService_Reorder_UnknownFolderID_ReturnsErrFolderNotFound(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	bogus := "does-not-exist"
	err := svc.Reorder(context.Background(), &bogus, nil)
	if !errors.Is(err, ErrFolderNotFound) {
		t.Fatalf("Reorder() error = %v, want ErrFolderNotFound", err)
	}
}

func TestService_CreateFolder_DuplicateName_ReturnsErrDuplicateAndDoesNotPersist(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	if _, err := svc.CreateFolder(context.Background(), "Work"); err != nil {
		t.Fatalf("CreateFolder() error = %v", err)
	}

	_, err := svc.CreateFolder(context.Background(), "Work")
	if !errors.Is(err, ErrDuplicateFolderName) {
		t.Fatalf("CreateFolder() error = %v, want ErrDuplicateFolderName", err)
	}
	if len(bc.calls) != 1 {
		t.Fatalf("broadcast calls = %v, want only the first create's", bc.calls)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(doc.Folders) != 1 {
		t.Fatalf("Load() folders = %+v, want the rejection to persist nothing", doc.Folders)
	}
}

// Comparison folds case and normalizes to NFC, matching fsstore.Canonicalize
// — so "work", surrounding whitespace, and an NFD-composed spelling are all
// the same name.
func TestService_CreateFolder_EquivalentName_ReturnsErrDuplicate(t *testing.T) {
	nfc := "Caf\u00e9"
	nfd := "Cafe\u0301"

	for _, tc := range []struct{ first, second string }{
		{"Work", "work"},
		{"Work", "WORK"},
		{"Work", "  Work  "},
		{nfc, nfd},
		{nfd, nfc},
		{nfc, "caf\u00e9"},
	} {
		dir := t.TempDir()
		registry := newTestRegistry(nil)
		svc := newTestService(t, dir, registry, &fakeBroadcaster{})

		if _, err := svc.CreateFolder(context.Background(), tc.first); err != nil {
			t.Fatalf("CreateFolder(%q) error = %v", tc.first, err)
		}
		_, err := svc.CreateFolder(context.Background(), tc.second)
		if !errors.Is(err, ErrDuplicateFolderName) {
			t.Fatalf("CreateFolder(%q) after %q: error = %v, want ErrDuplicateFolderName", tc.second, tc.first, err)
		}
	}
}

func TestService_RenameFolder_SetsNameAndBroadcasts(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	created, err := svc.CreateFolder(context.Background(), "Work")
	if err != nil {
		t.Fatalf("CreateFolder() error = %v", err)
	}

	renamed, err := svc.RenameFolder(context.Background(), created.ID, "  Personal  ")
	if err != nil {
		t.Fatalf("RenameFolder() error = %v", err)
	}
	if renamed.ID != created.ID || renamed.Name != "Personal" {
		t.Fatalf("RenameFolder() = %+v, want same ID with trimmed Name=Personal", renamed)
	}
	if len(bc.calls) != 2 || bc.calls[1] != EventBookmarkChanged {
		t.Fatalf("broadcast calls = %v, want a second %s", bc.calls, EventBookmarkChanged)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(doc.Folders) != 1 || doc.Folders[0].Name != "Personal" {
		t.Fatalf("Load() folders = %+v, want the rename persisted", doc.Folders)
	}
}

func TestService_RenameFolder_DuplicateName_ReturnsErrDuplicateNoWrite(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	if _, err := svc.CreateFolder(context.Background(), "Work"); err != nil {
		t.Fatalf("CreateFolder() error = %v", err)
	}
	personal, err := svc.CreateFolder(context.Background(), "Personal")
	if err != nil {
		t.Fatalf("CreateFolder() error = %v", err)
	}

	if _, err := svc.RenameFolder(context.Background(), personal.ID, "WORK"); !errors.Is(err, ErrDuplicateFolderName) {
		t.Fatalf("RenameFolder() error = %v, want ErrDuplicateFolderName", err)
	}
	if len(bc.calls) != 2 {
		t.Fatalf("broadcast calls = %v, want none on rejection", bc.calls)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	for _, f := range doc.Folders {
		if f.ID == personal.ID && f.Name != "Personal" {
			t.Fatalf("Load() folder = %+v, want the rejected rename to persist nothing", f)
		}
	}
}

// A folder is not its own duplicate — a pure case change of its current name
// must be accepted, not rejected against itself.
func TestService_RenameFolder_OwnName_Succeeds(t *testing.T) {
	for _, name := range []string{"Work", "WORK", "work"} {
		dir := t.TempDir()
		registry := newTestRegistry(nil)
		svc := newTestService(t, dir, registry, &fakeBroadcaster{})

		created, err := svc.CreateFolder(context.Background(), "Work")
		if err != nil {
			t.Fatalf("CreateFolder() error = %v", err)
		}
		got, err := svc.RenameFolder(context.Background(), created.ID, name)
		if err != nil {
			t.Fatalf("RenameFolder(%q) error = %v, want success", name, err)
		}
		if got.Name != name {
			t.Fatalf("RenameFolder(%q) name = %q, want %q", name, got.Name, name)
		}
	}
}

func TestService_RenameFolder_UnknownID_ReturnsErrFolderNotFound(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	if _, err := svc.RenameFolder(context.Background(), uuid.NewString(), "Work"); !errors.Is(err, ErrFolderNotFound) {
		t.Fatalf("RenameFolder() error = %v, want ErrFolderNotFound", err)
	}
	if len(bc.calls) != 0 {
		t.Fatalf("broadcast calls = %v, want none on rejection", bc.calls)
	}
}

func TestService_RenameFolder_EmptyName_ReturnsErrInvalidName(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	created, err := svc.CreateFolder(context.Background(), "Work")
	if err != nil {
		t.Fatalf("CreateFolder() error = %v", err)
	}

	for _, name := range []string{"", "   ", "\t\n"} {
		if _, err := svc.RenameFolder(context.Background(), created.ID, name); !errors.Is(err, ErrInvalidName) {
			t.Fatalf("RenameFolder(%q) error = %v, want ErrInvalidName", name, err)
		}
	}
	if len(bc.calls) != 1 {
		t.Fatalf("broadcast calls = %v, want none beyond the create", bc.calls)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if doc.Folders[0].Name != "Work" {
		t.Fatalf("Load() folders = %+v, want the original name untouched", doc.Folders)
	}
}
