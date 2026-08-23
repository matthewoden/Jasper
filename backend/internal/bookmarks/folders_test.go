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

func TestService_RenameFolder_UnknownID_ReturnsErrFolderNotFound(t *testing.T) {
	dir := t.TempDir()
	registry := newTestRegistry(nil)
	bc := &fakeBroadcaster{}
	svc := newTestService(t, dir, registry, bc)

	_, err := svc.RenameFolder(context.Background(), uuid.NewString(), "Personal")
	if !errors.Is(err, ErrFolderNotFound) {
		t.Fatalf("RenameFolder() error = %v, want ErrFolderNotFound", err)
	}
	if len(bc.calls) != 0 {
		t.Fatalf("RenameFolder() on unknown id broadcast %v, want none", bc.calls)
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
	bc.calls = nil

	if _, err := svc.RenameFolder(context.Background(), created.ID, "   "); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("RenameFolder() error = %v, want ErrInvalidName", err)
	}
	if len(bc.calls) != 0 {
		t.Fatalf("RenameFolder() with an empty name broadcast %v, want none", bc.calls)
	}

	doc, err := Load(dir, registry, testLogger())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if doc.Folders[0].Name != "Work" {
		t.Fatalf("Load() folders = %+v, want the original name untouched", doc.Folders)
	}
}
