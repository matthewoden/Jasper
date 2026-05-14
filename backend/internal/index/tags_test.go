package index

// Tags store tests for Plan 06-04 Task 2.
//
// Tests exercise SyncTags, ListTags, NotesByTag, RenameTag, DeleteTag and
// the ReconcileWithRegistry (tag side) extension.
//
// Helper functions writeNote and newReconcileFixture are defined in
// reconcile_test.go (same package).

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

// newTagTestIndexer returns an Indexer with all three migrations applied
// (001_initial, 002_tags_backlinks, 003_fts). As of Plan 07-03, newTestIndexer
// applies all three migrations — this helper exists for backward compatibility
// with tests that need the tags/backlinks tables.
func newTagTestIndexer(t *testing.T) (*Indexer, string) {
	t.Helper()
	// newTestIndexer now applies 001, 002, and 003 — no additional migration
	// application needed here.
	return newTestIndexer(t)
}

// insertNote is a lower-level helper that inserts a notes row directly via
// SQL (bypassing Upsert's title extraction) so tests can control mtime values.
func insertNote(t *testing.T, idx *Indexer, id uuid.UUID, path string, mtimeUnix int64) {
	t.Helper()
	_, err := idx.Pair.Writer.ExecContext(context.Background(),
		`INSERT INTO notes(id, path, title, mtime_unix, size_bytes, checksum_sha256, created_at, updated_at)
		 VALUES(?, ?, ?, ?, 0, '', ?, ?)`,
		id.String(), path, path, mtimeUnix, 1730000000, 1730000000)
	if err != nil {
		t.Fatalf("insertNote(%q): %v", path, err)
	}
}

// newNoteID mints a fresh UUID, inserts a notes row, and returns the UUID.
func newNoteID(t *testing.T, idx *Indexer, path string, mtimeUnix int64) uuid.UUID {
	t.Helper()
	id := uuid.New()
	insertNote(t, idx, id, path, mtimeUnix)
	return id
}

// ---------------------------------------------------------------------------
// SyncTags
// ---------------------------------------------------------------------------

// TestSyncTags_NewTags — note has no prior tags; sync ["foo", "bar"];
// note_tags has 2 rows; tags table has rows for "foo" and "bar" (A1).
func TestSyncTags_NewTags(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	noteID := newNoteID(t, idx, "a.md", 1700000000)

	if err := idx.SyncTags(context.Background(), noteID, []string{"foo", "bar"}); err != nil {
		t.Fatalf("SyncTags: %v", err)
	}

	ctx := context.Background()
	var cnt int
	if err := idx.Pair.Reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM note_tags WHERE note_id = ?`, noteID.String(),
	).Scan(&cnt); err != nil {
		t.Fatalf("count note_tags: %v", err)
	}
	if cnt != 2 {
		t.Errorf("note_tags count: got %d, want 2", cnt)
	}

	tags, err := idx.ListTags(ctx)
	if err != nil {
		t.Fatalf("ListTags: %v", err)
	}
	if len(tags) != 2 {
		t.Errorf("ListTags count: got %d, want 2", len(tags))
	}
}

// TestSyncTags_Replace — replace prior ["foo","bar"] with ["bar","baz"];
// orphan "foo" removed (A2 + D-05).
func TestSyncTags_Replace(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	noteID := newNoteID(t, idx, "a.md", 1700000000)

	ctx := context.Background()
	if err := idx.SyncTags(ctx, noteID, []string{"foo", "bar"}); err != nil {
		t.Fatalf("SyncTags 1: %v", err)
	}
	if err := idx.SyncTags(ctx, noteID, []string{"bar", "baz"}); err != nil {
		t.Fatalf("SyncTags 2: %v", err)
	}

	tags, err := idx.ListTags(ctx)
	if err != nil {
		t.Fatalf("ListTags: %v", err)
	}
	// "foo" should be gone (orphan); "bar" and "baz" should remain.
	tagNames := make(map[string]bool, len(tags))
	for _, tg := range tags {
		tagNames[tg.Name] = true
	}
	if tagNames["foo"] {
		t.Errorf("orphan 'foo' still present after replace")
	}
	if !tagNames["bar"] {
		t.Errorf("'bar' missing after replace")
	}
	if !tagNames["baz"] {
		t.Errorf("'baz' missing after replace")
	}
}

// TestSyncTags_Empty — sync empty slice removes all tags for note and
// orphan tags (A3).
func TestSyncTags_Empty(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	noteID := newNoteID(t, idx, "a.md", 1700000000)

	ctx := context.Background()
	if err := idx.SyncTags(ctx, noteID, []string{"foo", "bar"}); err != nil {
		t.Fatalf("SyncTags seed: %v", err)
	}
	if err := idx.SyncTags(ctx, noteID, []string{}); err != nil {
		t.Fatalf("SyncTags empty: %v", err)
	}

	var cnt int
	if err := idx.Pair.Reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM note_tags WHERE note_id = ?`, noteID.String(),
	).Scan(&cnt); err != nil {
		t.Fatalf("count: %v", err)
	}
	if cnt != 0 {
		t.Errorf("note_tags count: got %d, want 0", cnt)
	}
	tags, _ := idx.ListTags(ctx)
	if len(tags) != 0 {
		t.Errorf("ListTags: expected 0 tags, got %d", len(tags))
	}
}

// TestSyncTags_Nil — nil is equivalent to empty (A4).
func TestSyncTags_Nil(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	noteID := newNoteID(t, idx, "a.md", 1700000000)

	ctx := context.Background()
	if err := idx.SyncTags(ctx, noteID, []string{"foo"}); err != nil {
		t.Fatalf("SyncTags seed: %v", err)
	}
	if err := idx.SyncTags(ctx, noteID, nil); err != nil {
		t.Fatalf("SyncTags nil: %v", err)
	}

	tags, _ := idx.ListTags(ctx)
	if len(tags) != 0 {
		t.Errorf("nil sync: expected 0 tags, got %d", len(tags))
	}
}

// TestSyncTags_OrphanCleanup — shared tag carried by 2 notes; removing
// it from one does NOT delete the tag row; removing from both DOES (A6).
func TestSyncTags_OrphanCleanup(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	note1 := newNoteID(t, idx, "a.md", 1700000000)
	note2 := newNoteID(t, idx, "b.md", 1700000001)

	ctx := context.Background()
	if err := idx.SyncTags(ctx, note1, []string{"shared"}); err != nil {
		t.Fatal(err)
	}
	if err := idx.SyncTags(ctx, note2, []string{"shared"}); err != nil {
		t.Fatal(err)
	}

	// Remove from note1 — tag should still exist (note2 carries it).
	if err := idx.SyncTags(ctx, note1, nil); err != nil {
		t.Fatal(err)
	}
	tags, _ := idx.ListTags(ctx)
	if len(tags) == 0 {
		t.Error("tag 'shared' removed too early (note2 still carries it)")
	}

	// Remove from note2 — tag should now be gone (orphan).
	if err := idx.SyncTags(ctx, note2, nil); err != nil {
		t.Fatal(err)
	}
	tags, _ = idx.ListTags(ctx)
	if len(tags) != 0 {
		t.Errorf("orphan tag still present: %v", tags)
	}
}

// TestSyncTags_Idempotency — calling SyncTags twice with the same tags
// produces the same final state (A7).
func TestSyncTags_Idempotency(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	noteID := newNoteID(t, idx, "a.md", 1700000000)
	ctx := context.Background()

	tagsInput := []string{"alpha", "beta"}
	if err := idx.SyncTags(ctx, noteID, tagsInput); err != nil {
		t.Fatal(err)
	}
	if err := idx.SyncTags(ctx, noteID, tagsInput); err != nil {
		t.Fatal(err)
	}

	tags, err := idx.ListTags(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(tags) != 2 {
		t.Errorf("idempotency: expected 2 tags, got %d", len(tags))
	}
}

// ---------------------------------------------------------------------------
// ListTags
// ---------------------------------------------------------------------------

// TestListTags_Empty — empty DB returns non-nil empty slice (B1).
func TestListTags_Empty(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	tags, err := idx.ListTags(context.Background())
	if err != nil {
		t.Fatalf("ListTags: %v", err)
	}
	if tags == nil {
		t.Fatal("ListTags returned nil, want empty slice")
	}
	if len(tags) != 0 {
		t.Errorf("ListTags: got %d entries, want 0", len(tags))
	}
}

// TestListTags_AlphabeticalWithCounts — three tags with counts; returns
// alphabetical with correct counts (B2).
func TestListTags_AlphabeticalWithCounts(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	// foo=2, bar=5, baz=1
	paths := []string{"a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md"}
	tagsets := [][]string{
		{"foo"},
		{"foo"},
		{"bar"},
		{"bar"},
		{"bar"},
		{"bar"},
		{"bar"},
		{"baz"},
	}
	for i, path := range paths {
		id := newNoteID(t, idx, path, int64(1700000000+i))
		if err := idx.SyncTags(ctx, id, tagsets[i]); err != nil {
			t.Fatalf("SyncTags[%d]: %v", i, err)
		}
	}

	tags, err := idx.ListTags(ctx)
	if err != nil {
		t.Fatalf("ListTags: %v", err)
	}
	if len(tags) != 3 {
		t.Fatalf("ListTags count: got %d, want 3", len(tags))
	}
	// Alphabetical: bar, baz, foo.
	wantOrder := []struct {
		name  string
		count int
	}{
		{"bar", 5},
		{"baz", 1},
		{"foo", 2},
	}
	for i, w := range wantOrder {
		if tags[i].Name != w.name {
			t.Errorf("[%d] Name: got %q, want %q", i, tags[i].Name, w.name)
		}
		if tags[i].Count != w.count {
			t.Errorf("[%d] Count: got %d, want %d", i, tags[i].Count, w.count)
		}
	}
}

// ---------------------------------------------------------------------------
// NotesByTag
// ---------------------------------------------------------------------------

// TestNotesByTag_ReturnsMatchingNotes — tag "foo" carried by 3 notes;
// returns 3 NoteSummary entries ordered by mtime desc (C1).
func TestNotesByTag_ReturnsMatchingNotes(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	n1 := newNoteID(t, idx, "a.md", 1700000001)
	n2 := newNoteID(t, idx, "b.md", 1700000003)
	n3 := newNoteID(t, idx, "c.md", 1700000002)

	if err := idx.SyncTags(ctx, n1, []string{"foo"}); err != nil {
		t.Fatal(err)
	}
	if err := idx.SyncTags(ctx, n2, []string{"foo"}); err != nil {
		t.Fatal(err)
	}
	if err := idx.SyncTags(ctx, n3, []string{"foo"}); err != nil {
		t.Fatal(err)
	}

	notes, err := idx.NotesByTag(ctx, "foo")
	if err != nil {
		t.Fatalf("NotesByTag: %v", err)
	}
	if len(notes) != 3 {
		t.Fatalf("NotesByTag: got %d, want 3", len(notes))
	}
	// Order should be mtime desc: b.md(3) > c.md(2) > a.md(1).
	wantOrder := []uuid.UUID{n2, n3, n1}
	for i, w := range wantOrder {
		if notes[i].ID != w {
			t.Errorf("notes[%d].ID: got %v, want %v", i, notes[i].ID, w)
		}
	}
}

// TestNotesByTag_NotFound — tag not found returns empty slice + nil error (C2).
func TestNotesByTag_NotFound(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)

	notes, err := idx.NotesByTag(context.Background(), "nosuchname")
	if err != nil {
		t.Fatalf("NotesByTag: %v", err)
	}
	if notes == nil {
		t.Fatal("NotesByTag: got nil, want empty slice")
	}
	if len(notes) != 0 {
		t.Errorf("NotesByTag: got %d entries, want 0", len(notes))
	}
}

// ---------------------------------------------------------------------------
// RenameTag
// ---------------------------------------------------------------------------

// TestRenameTag_HappyPath — 4 notes carry "foo"; RenameTag returns 4 IDs;
// tag renamed to "feature"; note_tags still reference correct tag (D1).
func TestRenameTag_HappyPath(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	paths := []string{"a.md", "b.md", "c.md", "d.md"}
	for i, p := range paths {
		id := newNoteID(t, idx, p, int64(1700000000+i))
		if err := idx.SyncTags(ctx, id, []string{"foo"}); err != nil {
			t.Fatal(err)
		}
	}

	affected, err := idx.RenameTag(ctx, "foo", "feature")
	if err != nil {
		t.Fatalf("RenameTag: %v", err)
	}
	if len(affected) != 4 {
		t.Errorf("RenameTag affected: got %d, want 4", len(affected))
	}

	// "foo" should no longer exist; "feature" should.
	tags, _ := idx.ListTags(ctx)
	tagNames := make(map[string]bool, len(tags))
	for _, tg := range tags {
		tagNames[tg.Name] = true
	}
	if tagNames["foo"] {
		t.Error("'foo' still present after rename")
	}
	if !tagNames["feature"] {
		t.Error("'feature' not found after rename")
	}

	// All 4 notes should now carry "feature".
	notes, err := idx.NotesByTag(ctx, "feature")
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 4 {
		t.Errorf("notes carrying 'feature': got %d, want 4", len(notes))
	}
}

// TestRenameTag_NotFound — returns ErrTagNotFound (D2).
func TestRenameTag_NotFound(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)

	_, err := idx.RenameTag(context.Background(), "ghost", "new")
	if err == nil {
		t.Fatal("expected ErrTagNotFound, got nil")
	}
	if err != ErrTagNotFound {
		t.Errorf("err: got %v, want ErrTagNotFound", err)
	}
}

// TestRenameTag_Collision — returns ErrTagCollision when newName exists (D3).
func TestRenameTag_Collision(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	n1 := newNoteID(t, idx, "a.md", 1700000000)
	n2 := newNoteID(t, idx, "b.md", 1700000001)
	if err := idx.SyncTags(ctx, n1, []string{"foo"}); err != nil {
		t.Fatal(err)
	}
	if err := idx.SyncTags(ctx, n2, []string{"bar"}); err != nil {
		t.Fatal(err)
	}

	_, err := idx.RenameTag(ctx, "foo", "bar")
	if err == nil {
		t.Fatal("expected ErrTagCollision, got nil")
	}
	if err != ErrTagCollision {
		t.Errorf("err: got %v, want ErrTagCollision", err)
	}
}

// TestRenameTag_InvalidName — returns ErrInvalidTagName for invalid charset (D5).
func TestRenameTag_InvalidName(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	n := newNoteID(t, idx, "a.md", 1700000000)
	if err := idx.SyncTags(ctx, n, []string{"foo"}); err != nil {
		t.Fatal(err)
	}

	// Name with space is invalid per D-22.
	_, err := idx.RenameTag(ctx, "foo", "bad name")
	if err == nil {
		t.Fatal("expected ErrInvalidTagName, got nil")
	}
	if err != ErrInvalidTagName {
		t.Errorf("err: got %v, want ErrInvalidTagName", err)
	}
}

// ---------------------------------------------------------------------------
// DeleteTag
// ---------------------------------------------------------------------------

// TestDeleteTag_HappyPath — 3 notes carry "foo"; DeleteTag returns 3 IDs;
// tag row gone; note_tags cascade deleted (E1).
func TestDeleteTag_HappyPath(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)
	ctx := context.Background()

	paths := []string{"a.md", "b.md", "c.md"}
	for i, p := range paths {
		id := newNoteID(t, idx, p, int64(1700000000+i))
		if err := idx.SyncTags(ctx, id, []string{"foo"}); err != nil {
			t.Fatal(err)
		}
	}

	affected, err := idx.DeleteTag(ctx, "foo")
	if err != nil {
		t.Fatalf("DeleteTag: %v", err)
	}
	if len(affected) != 3 {
		t.Errorf("affected: got %d, want 3", len(affected))
	}

	tags, _ := idx.ListTags(ctx)
	if len(tags) != 0 {
		t.Errorf("tags after delete: got %d, want 0", len(tags))
	}
}

// TestDeleteTag_NotFound — returns ErrTagNotFound (E2).
func TestDeleteTag_NotFound(t *testing.T) {
	t.Parallel()
	idx, _ := newTagTestIndexer(t)

	_, err := idx.DeleteTag(context.Background(), "ghost")
	if err == nil {
		t.Fatal("expected ErrTagNotFound, got nil")
	}
	if err != ErrTagNotFound {
		t.Errorf("err: got %v, want ErrTagNotFound", err)
	}
}

// ---------------------------------------------------------------------------
// ReconcileWithRegistry — tag side (Task 2 portion)
// ---------------------------------------------------------------------------

// TestReconcileWithTags_FullReindex — full reindex over .md files with
// frontmatter tags populates the tags + note_tags tables (H1 subset).
func TestReconcileWithTags_FullReindex(t *testing.T) {
	t.Parallel()
	// Create fixture with notes dir on disk.
	idx, notesDir := newTagTestIndexer(t)
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}

	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "a.md",
		"---\ntags: [alpha, beta]\n---\n\n# Alpha Note\n", mtime)
	writeNote(t, notesDir, "b.md",
		"---\ntags: [beta]\n---\n\n# Beta Note\n", mtime)
	writeNote(t, notesDir, "c.md",
		"# No Tags\n", mtime)

	if _, err := idx.ReconcileWithRegistry(context.Background(), ModeFull, nil); err != nil {
		t.Fatalf("ReconcileWithRegistry: %v", err)
	}

	ctx := context.Background()
	tags, err := idx.ListTags(ctx)
	if err != nil {
		t.Fatalf("ListTags: %v", err)
	}
	// Expect: alpha(1), beta(2)
	tagMap := make(map[string]int)
	for _, tg := range tags {
		tagMap[tg.Name] = tg.Count
	}
	if tagMap["alpha"] != 1 {
		t.Errorf("alpha count: got %d, want 1", tagMap["alpha"])
	}
	if tagMap["beta"] != 2 {
		t.Errorf("beta count: got %d, want 2", tagMap["beta"])
	}
}

// TestReconcileWithTags_TAGS05_WipeAndRebuild — wiping the DB and rerunning
// ReconcileWithRegistry restores the same tag state (TAGS-05).
func TestReconcileWithTags_TAGS05_WipeAndRebuild(t *testing.T) {
	t.Parallel()
	idx, notesDir := newTagTestIndexer(t)
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}

	mtime := time.Unix(1700000000, 0)
	writeNote(t, notesDir, "x.md",
		"---\ntags: [project, work]\n---\n\n# X\n", mtime)

	// First reconcile.
	if _, err := idx.ReconcileWithRegistry(context.Background(), ModeFull, nil); err != nil {
		t.Fatal(err)
	}

	// Wipe notes + tags + note_tags + backlinks tables.
	ctx := context.Background()
	if _, err := idx.Pair.Writer.ExecContext(ctx, `DELETE FROM backlinks`); err != nil {
		t.Fatal(err)
	}
	if _, err := idx.Pair.Writer.ExecContext(ctx, `DELETE FROM note_tags`); err != nil {
		t.Fatal(err)
	}
	if _, err := idx.Pair.Writer.ExecContext(ctx, `DELETE FROM tags`); err != nil {
		t.Fatal(err)
	}
	if _, err := idx.Pair.Writer.ExecContext(ctx, `DELETE FROM notes`); err != nil {
		t.Fatal(err)
	}

	// Second reconcile — should restore all tables.
	if _, err := idx.ReconcileWithRegistry(ctx, ModeFull, nil); err != nil {
		t.Fatal(err)
	}

	tags, err := idx.ListTags(ctx)
	if err != nil {
		t.Fatal(err)
	}
	tagMap := make(map[string]int)
	for _, tg := range tags {
		tagMap[tg.Name] = tg.Count
	}
	if tagMap["project"] != 1 {
		t.Errorf("TAGS-05: project count: got %d, want 1", tagMap["project"])
	}
	if tagMap["work"] != 1 {
		t.Errorf("TAGS-05: work count: got %d, want 1", tagMap["work"])
	}
}
