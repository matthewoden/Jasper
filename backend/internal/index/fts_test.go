package index

import (
	"context"
	"testing"

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

// TestFTSUpsertSync — Plan 07-03 lands the indexer FTS sync hook; this test verifies
// that Upsert/Delete keep notes_fts in lockstep with notes. SCAFFOLD ONLY.
func TestFTSUpsertSync(t *testing.T) {
	t.Skip("scaffold — implemented in Plan 07-03 (indexer FTS sync)")
}

// TestFTSDivergenceRebuild — Plan 07-03 startup divergence check rebuilds notes_fts
// when row counts disagree. SCAFFOLD ONLY.
func TestFTSDivergenceRebuild(t *testing.T) {
	t.Skip("scaffold — implemented in Plan 07-03 (startup divergence check)")
}
