package index

import (
	"context"
	"testing"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

func upsertTitled(t *testing.T, idx *Indexer, path, title string) notes.ID {
	t.Helper()
	id := notes.NewID()
	if err := idx.Upsert(context.Background(), notes.NoteRecord{ID: id, Path: path, Title: title, MTimeUnix: 1}); err != nil {
		t.Fatalf("Upsert %s: %v", path, err)
	}
	return id
}

func TestDelete_WritesTombstone_UpsertClearsIt(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)
	ctx := context.Background()
	id := upsertTitled(t, idx, "notes/a.md", "Alpha")

	if err := idx.Delete(ctx, id); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	ts, ok, err := idx.GetTombstone(ctx, id.String())
	if err != nil || !ok {
		t.Fatalf("GetTombstone = %+v, %v, %v", ts, ok, err)
	}
	if ts.ID != id.String() || ts.LastPath != "notes/a.md" || ts.LastTitle != "Alpha" || ts.DeletedAt != 1730000000 || ts.ReplacedBy != "" {
		t.Errorf("tombstone = %+v", ts)
	}

	if err := idx.Upsert(ctx, notes.NoteRecord{ID: id, Path: "notes/a.md", Title: "Alpha", MTimeUnix: 2}); err != nil {
		t.Fatalf("re-Upsert: %v", err)
	}
	if _, ok, _ := idx.GetTombstone(ctx, id.String()); ok {
		t.Errorf("tombstone survived the note's return")
	}
}

func TestDelete_UnknownIDLeavesNoTombstone(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)
	id := notes.NewID()
	if err := idx.Delete(context.Background(), id); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, ok, _ := idx.GetTombstone(context.Background(), id.String()); ok {
		t.Errorf("a row that never existed got a tombstone")
	}
}

func TestDeleteByPathPrefix_TombstonesFolder_NotWholesaleDrop(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)
	ctx := context.Background()
	inFolder := upsertTitled(t, idx, "proj/a.md", "In folder")
	outside := upsertTitled(t, idx, "b.md", "Outside")

	if _, err := idx.DeleteByPathPrefix(ctx, "proj"); err != nil {
		t.Fatalf("DeleteByPathPrefix: %v", err)
	}
	if ts, ok, _ := idx.GetTombstone(ctx, inFolder.String()); !ok || ts.LastTitle != "In folder" {
		t.Errorf("folder child not tombstoned: %+v %v", ts, ok)
	}
	if _, ok, _ := idx.GetTombstone(ctx, outside.String()); ok {
		t.Errorf("note outside the folder was tombstoned")
	}

	if _, err := idx.DeleteByPathPrefix(ctx, ""); err != nil {
		t.Fatalf("DeleteByPathPrefix(\"\"): %v", err)
	}
	if _, ok, _ := idx.GetTombstone(ctx, outside.String()); ok {
		t.Errorf("a rebuild's wholesale drop wrote tombstones")
	}
}
