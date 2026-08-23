package bookmarks

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
)

func TestService_RenameFolder_PersistsAndBroadcasts(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	created, err := svc.CreateFolder(context.Background(), "Work")
	if err != nil {
		t.Fatalf("CreateFolder() error = %v", err)
	}
	bc.calls = nil

	got, err := svc.RenameFolder(context.Background(), created.ID, "  Personal  ")
	if err != nil {
		t.Fatalf("RenameFolder() error = %v", err)
	}
	if got.ID != created.ID || got.Name != "Personal" {
		t.Fatalf("RenameFolder() = %+v, want id %s name Personal (trimmed)", got, created.ID)
	}
	if len(bc.calls) != 1 || bc.calls[0] != EventBookmarkChanged {
		t.Fatalf("RenameFolder() broadcast calls = %v, want exactly one %s", bc.calls, EventBookmarkChanged)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(doc.Folders) != 1 || doc.Folders[0].Name != "Personal" {
		t.Fatalf("Load() folders = %+v, want the rename persisted", doc.Folders)
	}
}

func TestService_RenameFolder_KeepsBookmarkMembership(t *testing.T) {
	dir := t.TempDir()
	noteID := uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{noteID: "notes/a.md"})
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	folder, err := svc.CreateFolder(context.Background(), "Work")
	if err != nil {
		t.Fatalf("CreateFolder() error = %v", err)
	}
	if _, err := svc.Add(context.Background(), noteID, &folder.ID); err != nil {
		t.Fatalf("Add() error = %v", err)
	}

	if _, err := svc.RenameFolder(context.Background(), folder.ID, "Personal"); err != nil {
		t.Fatalf("RenameFolder() error = %v", err)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(doc.Bookmarks) != 1 {
		t.Fatalf("Load() bookmarks = %+v, want the membership untouched", doc.Bookmarks)
	}
	if doc.Bookmarks[0].FolderID == nil || *doc.Bookmarks[0].FolderID != folder.ID {
		t.Fatalf("Load() bookmark folder = %+v, want still %s", doc.Bookmarks[0].FolderID, folder.ID)
	}
}

// DeleteFolder must never delete the bookmarks inside it: they are
// reparented to top level and renumbered contiguously alongside whatever
// was already there.
func TestService_DeleteFolder_ReparentsBookmarksToTopLevel(t *testing.T) {
	dir := t.TempDir()
	topID, aID, bID := uuid.New(), uuid.New(), uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{
		topID: "notes/top.md",
		aID:   "notes/a.md",
		bID:   "notes/b.md",
	})
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	if _, err := svc.Add(context.Background(), topID, nil); err != nil {
		t.Fatalf("Add() error = %v", err)
	}
	folder, err := svc.CreateFolder(context.Background(), "Work")
	if err != nil {
		t.Fatalf("CreateFolder() error = %v", err)
	}
	for _, id := range []uuid.UUID{aID, bID} {
		if _, err := svc.Add(context.Background(), id, &folder.ID); err != nil {
			t.Fatalf("Add() error = %v", err)
		}
	}
	bc.calls = nil

	if err := svc.DeleteFolder(context.Background(), folder.ID); err != nil {
		t.Fatalf("DeleteFolder() error = %v", err)
	}
	if len(bc.calls) != 1 || bc.calls[0] != EventBookmarkChanged {
		t.Fatalf("DeleteFolder() broadcast calls = %v, want exactly one %s", bc.calls, EventBookmarkChanged)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(doc.Folders) != 0 {
		t.Fatalf("Load() folders = %+v, want the folder gone", doc.Folders)
	}
	if len(doc.Bookmarks) != 3 {
		t.Fatalf("Load() bookmarks = %+v, want all 3 kept", doc.Bookmarks)
	}

	seenOrders := make(map[int]bool, len(doc.Bookmarks))
	for _, bm := range doc.Bookmarks {
		if bm.FolderID != nil {
			t.Fatalf("bookmark %s folder = %v, want top level (nil)", bm.NoteID, *bm.FolderID)
		}
		if bm.Order < 0 || bm.Order > 2 || seenOrders[bm.Order] {
			t.Fatalf("Load() bookmarks = %+v, want contiguous 0..2 orders", doc.Bookmarks)
		}
		seenOrders[bm.Order] = true
	}
}

func TestService_DeleteFolder_UnknownID_ReturnsErrFolderNotFound(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	if err := svc.DeleteFolder(context.Background(), uuid.NewString()); !errors.Is(err, ErrFolderNotFound) {
		t.Fatalf("DeleteFolder() error = %v, want ErrFolderNotFound", err)
	}
	if len(bc.calls) != 0 {
		t.Fatalf("DeleteFolder() on unknown id broadcast %v, want none", bc.calls)
	}
}

func TestService_DeleteFolder_LeavesOtherFoldersIntact(t *testing.T) {
	dir := t.TempDir()
	keptNoteID := uuid.New()
	registry := newTestRegistry(map[uuid.UUID]string{keptNoteID: "notes/kept.md"})
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	doomed, err := svc.CreateFolder(context.Background(), "Doomed")
	if err != nil {
		t.Fatalf("CreateFolder() error = %v", err)
	}
	kept, err := svc.CreateFolder(context.Background(), "Kept")
	if err != nil {
		t.Fatalf("CreateFolder() error = %v", err)
	}
	if _, err := svc.Add(context.Background(), keptNoteID, &kept.ID); err != nil {
		t.Fatalf("Add() error = %v", err)
	}

	if err := svc.DeleteFolder(context.Background(), doomed.ID); err != nil {
		t.Fatalf("DeleteFolder() error = %v", err)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(doc.Folders) != 1 || doc.Folders[0].ID != kept.ID {
		t.Fatalf("Load() folders = %+v, want only %s left", doc.Folders, kept.ID)
	}
	if len(doc.Bookmarks) != 1 || doc.Bookmarks[0].FolderID == nil || *doc.Bookmarks[0].FolderID != kept.ID {
		t.Fatalf("Load() bookmarks = %+v, want the untouched folder's membership kept", doc.Bookmarks)
	}
}
