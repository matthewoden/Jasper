package index

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

func newReconcileFixture(t *testing.T) (*Indexer, string) {
	t.Helper()
	idx, notesDir := newTestIndexer(t)
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}
	return idx, notesDir
}

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

	var orig int64
	if err := idx.Pair.Reader.QueryRowContext(context.Background(),
		`SELECT updated_at FROM notes WHERE path = ?`, "a.md").Scan(&orig); err != nil {
		t.Fatal(err)
	}
	if orig != 1730000000 {
		t.Fatalf("seed updated_at: got %d, want 1730000000", orig)
	}

	idx.nowUnix = func() int64 { return 1740000000 }
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatal(err)
	}

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
// in the notes dir and reconciling assigns it the canonical ScratchpadUUID.
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

// TestReconcile_ReadoptsRestoredFile — TRASH-05 (D-05) regression: a .md file
// moved back into notes/ (manual restore from .trash/) is re-adopted by an
// incremental Reconcile with a FRESH, non-nil UUID.
//
// Flow:
//  1. Seed: write note.md, run full Reconcile, capture first UUID.
//  2. Simulate post-delete state: delete the index row + remove the file from
//     disk (mirrors Service.Delete which deletes the index row before moving
//     the file to .trash/).
//  3. Restore: drop a .md back under notes/ (the user's manual restore from
//     .trash/), run incremental Reconcile.
//  4. Assert: index row exists with a NON-NIL UUID (may differ from original —
//     UUIDs are not persisted in files; chooseID mints uuid.New() for a
//     newly-seen path). Assert the row's title matches the restored content.
func TestReconcile_ReadoptsRestoredFile(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)

	// Step 1 — seed initial state.
	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "restored.md", "# Original Title", mtime)
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("seed Reconcile: %v", err)
	}
	firstList, err := idx.List(context.Background())
	if err != nil {
		t.Fatalf("List after seed: %v", err)
	}
	var firstUUID uuid.UUID
	for _, sm := range firstList {
		if sm.Path == "restored.md" {
			firstUUID = sm.ID
			break
		}
	}
	if firstUUID == uuid.Nil {
		t.Fatalf("seed: restored.md not found in index")
	}

	// Step 2 — simulate post-delete: remove index row and disk file.
	if err := idx.Delete(context.Background(), firstUUID); err != nil {
		t.Fatalf("Delete from index: %v", err)
	}
	if err := os.Remove(filepath.Join(notesDir, "restored.md")); err != nil {
		t.Fatalf("Remove disk file: %v", err)
	}

	// Verify the row is gone.
	midList, _ := idx.List(context.Background())
	for _, sm := range midList {
		if sm.Path == "restored.md" {
			t.Fatalf("mid-state: restored.md still in index, want it deleted")
		}
	}

	// Step 3 — manual restore: place the file back under notes/.
	mtimeRestored := time.Unix(1700001000, 0)
	writeNote(t, notesDir, "restored.md", "# Restored Title", mtimeRestored)
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatalf("incremental Reconcile after restore: %v", err)
	}

	// Step 4 — assert re-adoption with fresh non-nil UUID and correct title.
	afterList, err := idx.List(context.Background())
	if err != nil {
		t.Fatalf("List after restore: %v", err)
	}
	var found bool
	for _, sm := range afterList {
		if sm.Path != "restored.md" {
			continue
		}
		found = true
		if sm.ID == uuid.Nil {
			t.Errorf("restored UUID is nil; chooseID must mint uuid.New() for a newly-seen path")
		}
		if sm.Title != "Restored Title" {
			t.Errorf("restored title: got %q, want %q", sm.Title, "Restored Title")
		}
	}
	if !found {
		t.Errorf("restored.md not found in index after incremental Reconcile")
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
// every notes.checksum_sha256 column is empty.
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

	mtimeNew := time.Unix(1700001000, 0)
	writeNote(t, notesDir, "a.md", "# New", mtimeNew)
	idx.nowUnix = func() int64 { return 1740000000 }
	if _, err := idx.Reconcile(context.Background(), ModeIncremental); err != nil {
		t.Fatal(err)
	}

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

// TestReconcileFull_IndexesInlineBodyTags — a note with tags ONLY as
// inline #hashtags in the body (no frontmatter) is indexed by reconcile:
// the tag appears in ListTags and carries the correct note count. This is
// the gap-closure case (30-14): a cold vault never saved through the app
// must still surface inline #tags in the vault-wide Tags list.
func TestReconcileFull_IndexesInlineBodyTags(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)

	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "a.md", "# Alpha\n\nSome text #foo bar #bar.\n", mtime)

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	tagsList, err := idx.ListTags(context.Background())
	if err != nil {
		t.Fatalf("ListTags: %v", err)
	}
	got := map[string]int{}
	for _, tw := range tagsList {
		got[tw.Name] = tw.Count
	}
	if got["foo"] != 1 {
		t.Errorf("tag foo count: got %d, want 1 (tags: %v)", got["foo"], tagsList)
	}
	if got["bar"] != 1 {
		t.Errorf("tag bar count: got %d, want 1 (tags: %v)", got["bar"], tagsList)
	}
}

// TestReconcileFull_UnionsFrontmatterAndBodyTags — a note with frontmatter
// `tags: [x]` AND an inline `#foo` body tag yields the deduplicated union
// {x, foo} in the index — no duplicate row when a tag appears in both
// (e.g. frontmatter `tags: [foo]` and inline `#foo` collapse to one).
func TestReconcileFull_UnionsFrontmatterAndBodyTags(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)

	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "a.md",
		"---\ntags: [x, foo]\n---\n\n# Alpha\n\nSome text #foo #bar.\n", mtime)

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	tagsList, err := idx.ListTags(context.Background())
	if err != nil {
		t.Fatalf("ListTags: %v", err)
	}
	got := map[string]int{}
	for _, tw := range tagsList {
		got[tw.Name] = tw.Count
	}
	want := map[string]int{"x": 1, "foo": 1, "bar": 1}
	if len(got) != len(want) {
		t.Fatalf("tag set: got %v, want %v", got, want)
	}
	for name, count := range want {
		if got[name] != count {
			t.Errorf("tag %q count: got %d, want %d", name, got[name], count)
		}
	}
}

// TestReconcileFull_SkipsHeadingHashesAsTags — heading lines (# Heading)
// are NOT indexed as tags, matching the pinned ExtractBodyTags contract
// (tags_test.go TestExtractBodyTags "heading" cases).
func TestReconcileFull_SkipsHeadingHashesAsTags(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)

	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "a.md", "# Heading\n\nBody text #realtag.\n", mtime)

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	tagsList, err := idx.ListTags(context.Background())
	if err != nil {
		t.Fatalf("ListTags: %v", err)
	}
	if len(tagsList) != 1 || tagsList[0].Name != "realtag" {
		t.Errorf("tags: got %v, want only [realtag]", tagsList)
	}
}
