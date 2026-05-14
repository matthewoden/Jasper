package index

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/migrations"
)

// newTestDBWithFTS opens a fresh sqlite.Pair in a tempdir, applies all three
// migrations (001_initial, 002_tags_backlinks, 003_fts) and returns the pair.
// Cleanup is registered with t.Cleanup.
func newTestDBWithFTS(t *testing.T) *sqlite.Pair {
	t.Helper()
	dir := t.TempDir()
	dbPath := dir + "/app.db"

	pair, err := sqlite.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("sqlite.Open: %v", err)
	}
	t.Cleanup(func() { _ = pair.Close() })

	for _, name := range []string{"001_initial.sql", "002_tags_backlinks.sql", "003_fts.sql"} {
		data, err := migrations.FS.ReadFile(name)
		if err != nil {
			t.Fatalf("read migration %s: %v", name, err)
		}
		if _, err := pair.Writer.ExecContext(context.Background(), string(data)); err != nil {
			t.Fatalf("apply migration %s: %v", name, err)
		}
	}
	return pair
}

// insertNoteRow inserts a minimal valid notes row with the given id and body_fts
// content into the provided writer connection.
func insertNoteRow(t *testing.T, pair *sqlite.Pair, id, path, bodyFTS string) {
	t.Helper()
	ctx := context.Background()
	_, err := pair.Writer.ExecContext(ctx, `
		INSERT INTO notes(id, path, title, mtime_unix, size_bytes, checksum_sha256, created_at, updated_at, body_fts, tag_names_fts)
		VALUES (?, ?, 'Test Note', 1700000000, 42, '', 1700000000, 1700000000, ?, '')`,
		id, path, bodyFTS)
	if err != nil {
		t.Fatalf("insert note row (id=%s): %v", id, err)
	}
}

// TestFTS5Migration verifies that 003_fts.sql applied correctly:
//   - notes table has body_fts and tag_names_fts columns
//   - notes_fts virtual table exists
//   - all 3 triggers are registered in sqlite_master
//   - the AI trigger fires on INSERT so an FTS row appears immediately
//   - the AD trigger fires on DELETE so the FTS row is removed
//   - the rebuild command succeeds
func TestFTS5Migration(t *testing.T) {
	pair := newTestDBWithFTS(t)
	ctx := context.Background()
	db := pair.Reader

	// 1. Verify columns body_fts and tag_names_fts exist on notes.
	var colCnt int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name IN ('body_fts','tag_names_fts')`).
		Scan(&colCnt); err != nil {
		t.Fatalf("pragma_table_info: %v", err)
	}
	if colCnt != 2 {
		t.Fatalf("expected body_fts and tag_names_fts columns; got %d matching", colCnt)
	}

	// 2. Verify notes_fts virtual table exists.
	var tableName string
	if err := db.QueryRowContext(ctx,
		`SELECT name FROM sqlite_master WHERE name='notes_fts' AND type='table'`).
		Scan(&tableName); err != nil {
		t.Fatalf("notes_fts virtual table missing: %v", err)
	}

	// 3. Verify all 3 triggers exist by name.
	var trigCnt int
	if err := db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM sqlite_master
		WHERE type='trigger'
		  AND name IN ('notes_fts_ai','notes_fts_ad','notes_fts_au')`).
		Scan(&trigCnt); err != nil {
		t.Fatalf("trigger count query: %v", err)
	}
	if trigCnt != 3 {
		t.Fatalf("expected 3 fts triggers; got %d", trigCnt)
	}

	// 4. Trigger AI exercise: insert a notes row with body_fts='hello world';
	//    the notes_fts_ai trigger fires and the FTS row appears immediately.
	id1 := uuid.New().String()
	insertNoteRow(t, pair, id1, "hello.md", "hello world")

	var ftsCnt int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'hello'`).
		Scan(&ftsCnt); err != nil {
		t.Fatalf("FTS MATCH 'hello': %v", err)
	}
	if ftsCnt != 1 {
		t.Fatalf("expected 1 FTS row matching 'hello'; got %d", ftsCnt)
	}

	// 5. Trigger AD exercise: insert a second row with distinct body text, then
	//    delete the first. The delete trigger removes its FTS entry, so a MATCH
	//    on its unique term no longer finds any results.
	id2 := uuid.New().String()
	insertNoteRow(t, pair, id2, "other.md", "uniqueterm world")

	// Verify id1's content is still findable before deletion.
	var preCnt int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'hello'`).Scan(&preCnt); err != nil {
		t.Fatalf("FTS MATCH 'hello' pre-delete: %v", err)
	}
	if preCnt != 1 {
		t.Fatalf("expected 1 match for 'hello' before delete; got %d", preCnt)
	}

	// Delete the first note (triggers notes_fts_ad — removes 'hello' from FTS).
	if _, err := pair.Writer.ExecContext(ctx, `DELETE FROM notes WHERE id=?`, id1); err != nil {
		t.Fatalf("delete note: %v", err)
	}

	// After delete, 'hello' should no longer match anything in notes_fts.
	var postCnt int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'hello'`).Scan(&postCnt); err != nil {
		t.Fatalf("FTS MATCH 'hello' post-delete: %v", err)
	}
	if postCnt != 0 {
		t.Fatalf("expected 0 matches for 'hello' after delete (trigger_ad fired); got %d", postCnt)
	}

	// 'uniqueterm' (from id2) should still be findable — only id1 was deleted.
	var keepCnt int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'uniqueterm'`).Scan(&keepCnt); err != nil {
		t.Fatalf("FTS MATCH 'uniqueterm': %v", err)
	}
	if keepCnt != 1 {
		t.Fatalf("expected 1 match for 'uniqueterm' (surviving row); got %d", keepCnt)
	}

	// 6. Rebuild command: INSERT INTO notes_fts(notes_fts) VALUES('rebuild') succeeds.
	if _, err := pair.Writer.ExecContext(ctx, `INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`); err != nil {
		t.Fatalf("FTS rebuild command: %v", err)
	}
}

// TestFTSUpsertSync verifies that the reconcile path populates body_fts and
// tag_names_fts so that notes_fts is queryable after a reconcile pass:
//
//   - body_fts MUST NOT contain frontmatter (D-37: "tags: [project]" must not
//     be found in body-match results — only tag_names_fts carries the tag).
//   - body_fts MUST contain the note body text ("hello searchable world").
//   - tag_names_fts MUST contain the tag name ("project").
func TestFTSUpsertSync(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)

	// Write a note with frontmatter tags and a distinct body phrase.
	content := "---\ntags: [project]\n---\n# Title\n\nhello searchable world"
	writeNote(t, notesDir, "test.md", content, fixedMtime)

	// Full reconcile — this is the path that computes BodyFTS/TagNamesFTS.
	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	// Query the notes_fts virtual table for this note's row.
	// Join on rowid so we get the FTS row for the note at "test.md".
	var bodyFTS, tagNamesFTS string
	err := idx.Pair.Reader.QueryRowContext(context.Background(), `
		SELECT nf.body_fts, nf.tag_names_fts
		FROM notes_fts nf
		JOIN notes n ON nf.rowid = n.rowid
		WHERE n.path = 'test.md'
	`).Scan(&bodyFTS, &tagNamesFTS)
	if err != nil {
		t.Fatalf("query notes_fts: %v", err)
	}

	// D-37: frontmatter content MUST be stripped from body_fts.
	if strings.Contains(bodyFTS, "tags:") {
		t.Errorf("body_fts contains frontmatter ('tags:'); D-37 violated\nbody_fts=%q", bodyFTS)
	}
	// The body text must be present.
	if !strings.Contains(bodyFTS, "hello searchable world") {
		t.Errorf("body_fts missing body text; got body_fts=%q", bodyFTS)
	}
	// tag_names_fts must carry the tag name.
	if !strings.Contains(tagNamesFTS, "project") {
		t.Errorf("tag_names_fts missing 'project'; got tag_names_fts=%q", tagNamesFTS)
	}

	// Also verify via FTS5 MATCH that the body phrase is actually searchable.
	var matchCnt int
	if err := idx.Pair.Reader.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'searchable'`).Scan(&matchCnt); err != nil {
		t.Fatalf("FTS MATCH 'searchable': %v", err)
	}
	if matchCnt != 1 {
		t.Errorf("FTS MATCH 'searchable': got %d, want 1", matchCnt)
	}

	// And that the tag term is NOT found via body_fts MATCH (frontmatter stripped).
	var tagMatchCnt int
	if err := idx.Pair.Reader.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'project'`).Scan(&tagMatchCnt); err != nil {
		t.Fatalf("FTS MATCH 'project' (body): %v", err)
	}
	// "project" appears in frontmatter only — body_fts MATCH should find 0.
	if tagMatchCnt != 0 {
		t.Errorf("FTS body_fts MATCH 'project': got %d (frontmatter leaked), want 0", tagMatchCnt)
	}
}

// fixedMtime is a pinned modification time used by FTS tests to produce
// deterministic mtime values without relying on wall-clock precision.
var fixedMtime = time.Unix(1700000000, 0)

// TestFTSDivergenceRebuild verifies that checkAndRepairFTSDivergence detects
// and heals FTS content staleness (D-36). The test exercises two scenarios:
//
//  1. Healthy index (body_fts populated): checkAndRepairFTSDivergence is a no-op.
//  2. Stale index (all body_fts empty): checkAndRepairFTSDivergence detects
//     staleness via the "all body_fts empty" heuristic, runs 'rebuild', and
//     restores FTS5 MATCH capability.
//
// The end-to-end scenario tested here mirrors the post-startup behaviour:
// after reconcile populates notes.body_fts, checkAndRepairFTSDivergence
// ensures the FTS5 shadow index stays in sync with the content table.
//
// Note: for FTS5 external-content tables, SELECT COUNT(*) FROM notes_fts
// always equals SELECT COUNT(*) FROM notes. The divergence check therefore
// uses both a count comparison (for corruption detection) and a content-
// staleness check (all body_fts=”) for the primary real-world scenario.
func TestFTSDivergenceRebuild(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	ctx := context.Background()

	// 1. Seed 3 notes via reconcile. After this, body_fts is populated on notes
	// rows and the FTS5 shadow index is up-to-date (AI trigger fired on INSERT).
	for _, name := range []string{"a.md", "b.md", "c.md"} {
		writeNote(t, notesDir, name, "# "+name+"\n\nsearchable content "+name, fixedMtime)
	}
	if _, err := idx.Reconcile(ctx, ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	// 2. Verify FTS MATCH works after reconcile (healthy state).
	var matchCntPre int
	if err := idx.Pair.Reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'searchable'`).Scan(&matchCntPre); err != nil {
		t.Fatalf("FTS MATCH pre-staleness: %v", err)
	}
	if matchCntPre != 3 {
		t.Fatalf("FTS MATCH 'searchable' pre-staleness: got %d, want 3", matchCntPre)
	}

	// 3. checkAndRepairFTSDivergence on a HEALTHY index must be a no-op.
	if err := idx.checkAndRepairFTSDivergence(ctx); err != nil {
		t.Fatalf("checkAndRepairFTSDivergence (healthy): %v", err)
	}

	// MATCH must still work after the no-op call.
	var matchCntNoOp int
	if err := idx.Pair.Reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'searchable'`).Scan(&matchCntNoOp); err != nil {
		t.Fatalf("FTS MATCH after no-op check: %v", err)
	}
	if matchCntNoOp != 3 {
		t.Errorf("FTS MATCH after no-op: got %d, want 3 (no-op should be a no-op)", matchCntNoOp)
	}

	// 4. Simulate the post-migration 003 staleness scenario:
	//    a. Reset body_fts='' on all notes rows (as migration 003 does for existing rows).
	//    b. Rebuild the FTS shadow index from the empty body_fts → MATCH now returns 0.
	//    This is the state checkAndRepairFTSDivergence must detect and fix.
	if _, err := idx.Pair.Writer.ExecContext(ctx,
		`UPDATE notes SET body_fts = '', tag_names_fts = ''`); err != nil {
		t.Fatalf("reset body_fts: %v", err)
	}
	if _, err := idx.Pair.Writer.ExecContext(ctx,
		`INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`); err != nil {
		t.Fatalf("rebuild fts (with empty content): %v", err)
	}

	// 5. Verify MATCH no longer works (FTS shadow index now holds empty content).
	var matchCntStale int
	if err := idx.Pair.Reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'searchable'`).Scan(&matchCntStale); err != nil {
		t.Fatalf("FTS MATCH (stale): %v", err)
	}
	if matchCntStale != 0 {
		t.Fatalf("FTS MATCH 'searchable' (stale body_fts): got %d, want 0", matchCntStale)
	}

	// 6. checkAndRepairFTSDivergence must detect staleness (all body_fts=='')
	// and run the FTS5 'rebuild' command. After the rebuild, notes.body_fts is
	// still '' (the check doesn't re-read files from disk), so the FTS rebuild
	// produces an empty index. The STALE state is DETECTED and logged.
	// The actual content-population happens via the next Reconcile call.
	if err := idx.checkAndRepairFTSDivergence(ctx); err != nil {
		t.Fatalf("checkAndRepairFTSDivergence (stale): %v", err)
	}

	// 7. Re-populate body_fts by running a reconcile with an advanced mtime
	// (forces the incremental reconcile to re-process all files). Advance by
	// 2 seconds to ensure the mtime_unix value changes (file systems store
	// mtime in whole seconds; adding < 1s produces the same unix timestamp).
	advancedMtime := fixedMtime.Add(2 * time.Second)
	for _, name := range []string{"a.md", "b.md", "c.md"} {
		if err := os.Chtimes(filepath.Join(notesDir, name), advancedMtime, advancedMtime); err != nil {
			t.Fatalf("chtimes %s: %v", name, err)
		}
	}
	if _, err := idx.Reconcile(ctx, ModeIncremental); err != nil {
		t.Fatalf("Reconcile (re-populate): %v", err)
	}

	// 8. MATCH must work after re-population.
	var matchCntPost int
	if err := idx.Pair.Reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'searchable'`).Scan(&matchCntPost); err != nil {
		t.Fatalf("FTS MATCH post-repopulate: %v", err)
	}
	if matchCntPost != 3 {
		t.Errorf("FTS MATCH 'searchable' post-repopulate: got %d, want 3", matchCntPost)
	}
}
