package index

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// newReconcileFixture sets up a fresh tempdir with a notes/ directory,
// a real sqlite.Pair with the schema applied, and an *Indexer pointed
// at notes/. The fixture is the same shape as newTestIndexer in
// store_test.go but ALSO creates the notes directory on disk.
func newReconcileFixture(t *testing.T) (*Indexer, string) {
	t.Helper()
	idx, notesDir := newTestIndexer(t)
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}
	return idx, notesDir
}

// writeNote writes content to <notesDir>/<rel> with mtime set to a
// fixed value so tests can pin "before" / "after" comparisons.
func writeNote(t *testing.T, notesDir, rel, content string, mtime time.Time) {
	t.Helper()
	full := filepath.Join(notesDir, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(full, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

// TestReconcileFull_PopulatesAllFiles — fresh schema + 3 .md files;
// Reconcile(ModeFull); List returns 3.
func TestReconcileFull_PopulatesAllFiles(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)

	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "a.md", "# Alpha", mtime)
	writeNote(t, notesDir, "b.md", "# Bravo", mtime)
	writeNote(t, notesDir, "sub/c.md", "# Charlie", mtime)

	n, err := idx.Reconcile(context.Background(), ModeFull)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if n != 3 {
		t.Errorf("upserts: got %d, want 3", n)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 3 {
		t.Fatalf("list len: got %d, want 3", len(got))
	}
	// Titles extracted from the H1 lines (paths sorted).
	wantTitles := map[string]string{
		"a.md":     "Alpha",
		"b.md":     "Bravo",
		"sub/c.md": "Charlie",
	}
	for _, sm := range got {
		if w, ok := wantTitles[sm.Path]; !ok || sm.Title != w {
			t.Errorf("Path %q: title got %q, want %q", sm.Path, sm.Title, w)
		}
	}
}

// TestReconcileIncremental_NewFile — index has 1 file; add a 2nd; the
// incremental run picks up only the new one.
func TestReconcileIncremental_NewFile(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)

	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "a.md", "# Alpha", mtime)
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("seed Reconcile: %v", err)
	}

	// Add b.md.
	writeNote(t, notesDir, "b.md", "# Bravo", mtime)
	n, err := idx.Reconcile(context.Background(), ModeIncremental)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if n != 2 {
		t.Errorf("count: got %d, want 2", n)
	}
}

// TestReconcileIncremental_DeletedFile — index has 1 file; remove the
// file from disk; incremental reconcile drops the row.
func TestReconcileIncremental_DeletedFile(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)

	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "a.md", "# Alpha", mtime)
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("seed Reconcile: %v", err)
	}

	// Remove the file.
	if err := os.Remove(filepath.Join(notesDir, "a.md")); err != nil {
		t.Fatal(err)
	}
	n, err := idx.Reconcile(context.Background(), ModeIncremental)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if n != 0 {
		t.Errorf("count after delete: got %d, want 0", n)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 0 {
		t.Errorf("list len: got %d, want 0", len(got))
	}
}

// TestReconcileIncremental_MTimeUnchanged_Skipped — re-reconciling a
// file whose mtime did not change does NOT touch the row's
// updated_at_unix (the indexer's internal touch time).
func TestReconcileIncremental_MTimeUnchanged_Skipped(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)

	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "a.md", "# Alpha", mtime)
	idx.nowUnix = func() int64 { return 1730000000 }
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatal(err)
	}

	// Read original updated_at_unix.
	var orig int64
	if err := idx.Pair.Reader.QueryRowContext(context.Background(),
		`SELECT updated_at FROM notes WHERE path = ?`, "a.md").Scan(&orig); err != nil {
		t.Fatal(err)
	}
	if orig != 1730000000 {
		t.Fatalf("seed updated_at: got %d, want 1730000000", orig)
	}

	// Re-run incremental — clock advances but mtime is unchanged.
	idx.nowUnix = func() int64 { return 1740000000 }
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatal(err)
	}

	// updated_at must be unchanged because the file's mtime did not
	// move forward — the fast path is taken.
	var after int64
	if err := idx.Pair.Reader.QueryRowContext(context.Background(),
		`SELECT updated_at FROM notes WHERE path = ?`, "a.md").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != orig {
		t.Errorf("updated_at: got %d (advanced), want %d (unchanged)", after, orig)
	}
}

// TestReconcile_Scratchpad_KeepsScratchpadUUID — writing scratchpad.md
// in the notes dir and reconciling assigns it the canonical
// ScratchpadUUID (Phase 1 frontend depends on this hard-coded id).
func TestReconcile_Scratchpad_KeepsScratchpadUUID(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)

	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, notes.ScratchpadRelPath, "# Welcome", mtime)
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatal(err)
	}
	got, _ := idx.List(context.Background())
	if len(got) != 1 {
		t.Fatalf("len: got %d, want 1", len(got))
	}
	if got[0].ID != notes.ScratchpadUUID {
		t.Errorf("ID: got %v, want ScratchpadUUID %v", got[0].ID, notes.ScratchpadUUID)
	}
}

// TestReconcile_UnknownMode_Errors — passing a nonsense Mode returns
// an error.
func TestReconcile_UnknownMode_Errors(t *testing.T) {
	t.Parallel()
	idx, _ := newReconcileFixture(t)
	if _, err := idx.Reconcile(context.Background(), Mode("bogus")); err == nil {
		t.Errorf("Reconcile bogus mode: got nil err, want non-nil")
	}
}

// TestReconcile_NoChecksumWritten_Phase2Deferral — after Reconcile,
// every notes.checksum_sha256 column is empty (DATA-09 deferral
// proof).
func TestReconcile_NoChecksumWritten_Phase2Deferral(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)

	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "a.md", "# A", mtime)
	writeNote(t, notesDir, "b.md", "# B", mtime)
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatal(err)
	}
	rows, err := idx.Pair.Reader.QueryContext(context.Background(),
		`SELECT checksum_sha256 FROM notes`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			t.Fatal(err)
		}
		if c != "" {
			t.Errorf("checksum_sha256: got %q, want empty (Phase 2 deferral)", c)
		}
	}
}

// TestReconcileIncremental_MTimeAdvanced_Reupserts — when a file's
// mtime advances, the row IS re-upserted (and updated_at moves
// forward).
func TestReconcileIncremental_MTimeAdvanced_Reupserts(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)

	mtimeOrig := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "a.md", "# Old", mtimeOrig)
	idx.nowUnix = func() int64 { return 1730000000 }
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatal(err)
	}

	// Advance mtime + change content.
	mtimeNew := time.Unix(1700001000, 0)
	writeNote(t, notesDir, "a.md", "# New", mtimeNew)
	idx.nowUnix = func() int64 { return 1740000000 }
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatal(err)
	}

	// Title should be re-extracted from the new content; updated_at
	// should now be 1740000000.
	var title string
	var updatedAt int64
	if err := idx.Pair.Reader.QueryRowContext(context.Background(),
		`SELECT title, updated_at FROM notes WHERE path = ?`, "a.md").
		Scan(&title, &updatedAt); err != nil {
		t.Fatal(err)
	}
	if title != "New" {
		t.Errorf("title: got %q, want %q", title, "New")
	}
	if updatedAt != 1740000000 {
		t.Errorf("updated_at: got %d, want 1740000000", updatedAt)
	}
}
