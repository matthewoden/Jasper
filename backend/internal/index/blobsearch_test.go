package index

import (
	"context"
	"testing"
	"time"
)

func TestSearchBlobNames(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	writeAttachment(t, notesDir, "attachments/Holiday Photo.png", []byte("a"), time.Unix(1700000200, 0))
	writeAttachment(t, notesDir, "proj/attachments/photo-2.png", []byte("b"), time.Unix(1700000100, 0))
	writeAttachment(t, notesDir, "attachments/report.pdf", []byte("c"), time.Unix(1700000300, 0))
	writeAttachment(t, notesDir, "photos/attachments/x.bin", []byte("d"), time.Unix(1700000400, 0))
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatal(err)
	}

	hits, err := idx.SearchBlobNames(context.Background(), "photo", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 2 || hits[0].Path != "attachments/Holiday Photo.png" || hits[1].Path != "proj/attachments/photo-2.png" {
		t.Errorf("hits = %+v, want the two photo files, newest first, matched on name not folder", hits)
	}
	if hits[0].ID == "" || hits[0].ID == hits[1].ID {
		t.Errorf("hits carry no distinct blob ids: %+v", hits)
	}
	if hits, _ := idx.SearchBlobNames(context.Background(), "%", 10); len(hits) != 0 {
		t.Errorf("a LIKE metacharacter matched: %+v", hits)
	}
	if hits, _ := idx.SearchBlobNames(context.Background(), "", 2); len(hits) != 2 {
		t.Errorf("empty query limit = %+v", hits)
	}
}

func TestAdoptAttachment(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	writeAttachment(t, notesDir, "attachments/new.png", []byte("v1"), time.Unix(1700000000, 0))

	id, err := idx.AdoptAttachment(context.Background(), "attachments/new.png")
	if err != nil {
		t.Fatal(err)
	}
	if got := blobAt(t, idx, "attachments/new.png"); got.ID != id || got.SHA256 != digestOf([]byte("v1")) || got.Mime != "image/png" {
		t.Errorf("adopted = %+v, id %s", got, id)
	}

	// Adopting again after an in-place change retires the old id.
	writeAttachment(t, notesDir, "attachments/new.png", []byte("v2!"), time.Unix(1700000100, 0))
	id2, err := idx.AdoptAttachment(context.Background(), "attachments/new.png")
	if err != nil || id2 == id {
		t.Fatalf("re-adopt: %s, %v", id2, err)
	}
	if ts, ok, _ := idx.GetTombstone(context.Background(), id); !ok || ts.ReplacedBy != id2 {
		t.Errorf("old blob tombstone = %+v, %v", ts, ok)
	}
	// Reconcile agrees with what the upload adopted: nothing to redo.
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatal(err)
	}
	if got := blobAt(t, idx, "attachments/new.png"); got.ID != id2 {
		t.Errorf("after reconcile = %+v", got)
	}
}
