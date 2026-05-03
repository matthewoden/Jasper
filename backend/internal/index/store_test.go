package index

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"golang.org/x/text/unicode/norm"

	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/migrations"
)

// newTestIndexer opens a real sqlite.Pair against a tempdir, applies
// 001_initial.sql, and returns an *Indexer wired against a notesDir.
// All cleanup is registered with t.Cleanup.
func newTestIndexer(t *testing.T) (*Indexer, string) {
	t.Helper()
	dir := t.TempDir()
	notesDir := filepath.Join(dir, "notes")
	dbPath := filepath.Join(dir, "app.db")

	pair, err := sqlite.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("sqlite.Open: %v", err)
	}
	t.Cleanup(func() { _ = pair.Close() })

	// Apply 001_initial.sql against the writer connection so the
	// `notes` table exists.
	sql, err := migrations.FS.ReadFile("001_initial.sql")
	if err != nil {
		t.Fatalf("read embedded migration: %v", err)
	}
	if _, err := pair.Writer.ExecContext(context.Background(), string(sql)); err != nil {
		t.Fatalf("apply 001_initial: %v", err)
	}

	idx := New(pair, notesDir, slog.Default())
	// Pin the clock for deterministic UpdatedAtUnix in tests.
	idx.nowUnix = func() int64 { return 1730000000 }
	return idx, notesDir
}

// rec1 returns a NoteRecord with stable values for path "a.md".
func rec1(id uuid.UUID) notes.NoteRecord {
	return notes.NoteRecord{
		ID:            id,
		Path:          "a.md",
		Title:         "First",
		MTimeUnix:     1700000000,
		SizeBytes:     42,
		Checksum:      "", // Phase 2: ALWAYS empty
		UpdatedAtUnix: 1730000000,
	}
}

// TestUpsert_NewRow — insert a single row; List returns it.
func TestUpsert_NewRow(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	id := uuid.New()
	if err := idx.Upsert(context.Background(), rec1(id)); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	got, err := idx.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len: got %d, want 1", len(got))
	}
	if got[0].ID != id {
		t.Errorf("ID: got %v, want %v", got[0].ID, id)
	}
	if got[0].Path != "a.md" {
		t.Errorf("Path: got %q, want %q", got[0].Path, "a.md")
	}
	if got[0].Title != "First" {
		t.Errorf("Title: got %q, want %q", got[0].Title, "First")
	}
}

// TestUpsert_UpdateExistingRow — second Upsert with same id and bumped
// mtime updates the row in place.
func TestUpsert_UpdateExistingRow(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	id := uuid.New()
	if err := idx.Upsert(context.Background(), rec1(id)); err != nil {
		t.Fatalf("upsert 1: %v", err)
	}
	r2 := rec1(id)
	r2.Title = "Second"
	r2.MTimeUnix = 1700000999
	if err := idx.Upsert(context.Background(), r2); err != nil {
		t.Fatalf("upsert 2: %v", err)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 1 {
		t.Fatalf("len: got %d, want 1", len(got))
	}
	if got[0].Title != "Second" {
		t.Errorf("Title: got %q, want %q", got[0].Title, "Second")
	}
}

// TestUpsert_CaseCollision_DifferentID — inserting a second row with
// the same path but a different id returns ErrCaseCollision and does
// NOT add a row.
func TestUpsert_CaseCollision_DifferentID(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	idA := uuid.New()
	if err := idx.Upsert(context.Background(), rec1(idA)); err != nil {
		t.Fatalf("upsert A: %v", err)
	}

	idB := uuid.New()
	r := rec1(idB) // same path, different id
	err := idx.Upsert(context.Background(), r)
	if err == nil {
		t.Fatalf("upsert B: got nil, want ErrCaseCollision")
	}
	if !errors.Is(err, notes.ErrCaseCollision) {
		t.Fatalf("err: got %v, want ErrCaseCollision", err)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 1 {
		t.Errorf("rows after collision: got %d, want 1", len(got))
	}
	if got[0].ID != idA {
		t.Errorf("surviving id: got %v, want %v", got[0].ID, idA)
	}
}

// TestUpsert_NoChecksumComputed — Phase 2 contract: rec.Checksum is
// "" and the column is stored as "" (NULL/empty). DATA-09 deferral.
func TestUpsert_NoChecksumComputed(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	id := uuid.New()
	if err := idx.Upsert(context.Background(), rec1(id)); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	var got string
	if err := idx.Pair.Reader.QueryRowContext(context.Background(),
		`SELECT checksum_sha256 FROM notes WHERE id = ?`, id.String()).Scan(&got); err != nil {
		t.Fatalf("query: %v", err)
	}
	if got != "" {
		t.Errorf("checksum_sha256: got %q, want empty (Phase 2 deferral)", got)
	}
}

// TestDelete_Existing — Delete removes the row.
func TestDelete_Existing(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	id := uuid.New()
	if err := idx.Upsert(context.Background(), rec1(id)); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := idx.Delete(context.Background(), id); err != nil {
		t.Fatalf("delete: %v", err)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 0 {
		t.Errorf("after delete: got %d rows, want 0", len(got))
	}
}

// TestDelete_Missing_NoOp — deleting a non-existent id is not an error.
func TestDelete_Missing_NoOp(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)
	if err := idx.Delete(context.Background(), uuid.New()); err != nil {
		t.Fatalf("delete missing: %v", err)
	}
}

// TestList_OrderedByPathASC — List returns rows in path-ascending
// order regardless of insertion order.
func TestList_OrderedByPathASC(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	// Insert in reverse-alphabetical order.
	r := rec1(uuid.New())
	r.Path = "z.md"
	if err := idx.Upsert(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	r = rec1(uuid.New())
	r.Path = "m.md"
	if err := idx.Upsert(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	r = rec1(uuid.New())
	r.Path = "a.md"
	if err := idx.Upsert(context.Background(), r); err != nil {
		t.Fatal(err)
	}

	got, _ := idx.List(context.Background())
	if len(got) != 3 {
		t.Fatalf("len: got %d, want 3", len(got))
	}
	want := []string{"a.md", "m.md", "z.md"}
	for i, w := range want {
		if got[i].Path != w {
			t.Errorf("[%d]: got %q, want %q", i, got[i].Path, w)
		}
	}
}

// TestList_EmptyTable_ReturnsNilSlice — no rows → empty/nil slice, no
// error.
func TestList_EmptyTable_ReturnsNilSlice(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)
	got, err := idx.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("len: got %d, want 0", len(got))
	}
}

// TestList_TitleAndUpdatedAtPopulated — wire fields are populated
// correctly; UpdatedAt is mtime-derived (NOT index-touch time).
func TestList_TitleAndUpdatedAtPopulated(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	id := uuid.New()
	r := rec1(id)
	if err := idx.Upsert(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 1 {
		t.Fatalf("len: got %d", len(got))
	}
	if got[0].Title != "First" {
		t.Errorf("Title: got %q, want %q", got[0].Title, "First")
	}
	// UpdatedAt is mtime_unix -> time.Time, NOT index-touch time.
	if got[0].UpdatedAt.Unix() != r.MTimeUnix {
		t.Errorf("UpdatedAt: got %d, want %d (file mtime, NOT index-touch %d)",
			got[0].UpdatedAt.Unix(), r.MTimeUnix, r.UpdatedAtUnix)
	}
}

// TestUpsert_NFC_Equivalence — paths that compare equal under NFC
// (e.g. NFD "café" vs NFC "café") collide. The pre-check that we
// store paths in their canonical lowercased+NFC form means inserting
// with the alternate normalization form should hit the unique-path
// constraint as a collision.
//
// Note: this test inserts two paths whose Go string-equality differs
// (one is NFD, one NFC) but whose canonical forms are equal. The
// indexer's caller (WalkVault + Reconcile) is responsible for
// canonicalizing before calling Upsert; this test verifies that IF a
// caller passes both forms (e.g. due to a bug), the second upsert
// against the SAME canonical bytes is rejected as a collision.
func TestUpsert_NFC_Equivalence(t *testing.T) {
	t.Parallel()
	idx, _ := newTestIndexer(t)

	idA := uuid.New()
	r := rec1(idA)
	r.Path = norm.NFC.String("café.md") // canonical form
	if err := idx.Upsert(context.Background(), r); err != nil {
		t.Fatalf("upsert A: %v", err)
	}

	// Caller passes a different id with the SAME canonical path bytes —
	// expected to collide because (path, id) row already exists.
	idB := uuid.New()
	r = rec1(idB)
	r.Path = norm.NFC.String("café.md")
	err := idx.Upsert(context.Background(), r)
	if err == nil {
		t.Fatalf("upsert B (same canonical path, different id): got nil, want ErrCaseCollision")
	}
	if !errors.Is(err, notes.ErrCaseCollision) {
		t.Fatalf("err: got %v, want ErrCaseCollision", err)
	}
}
