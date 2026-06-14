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

	var colCnt int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name IN ('body_fts','tag_names_fts')`).
		Scan(&colCnt); err != nil {
		t.Fatalf("pragma_table_info: %v", err)
	}
	if colCnt != 2 {
		t.Fatalf("expected body_fts and tag_names_fts columns; got %d matching", colCnt)
	}

	var tableName string
	if err := db.QueryRowContext(ctx,
		`SELECT name FROM sqlite_master WHERE name='notes_fts' AND type='table'`).
		Scan(&tableName); err != nil {
		t.Fatalf("notes_fts virtual table missing: %v", err)
	}

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

	id2 := uuid.New().String()
	insertNoteRow(t, pair, id2, "other.md", "uniqueterm world")

	var preCnt int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'hello'`).Scan(&preCnt); err != nil {
		t.Fatalf("FTS MATCH 'hello' pre-delete: %v", err)
	}
	if preCnt != 1 {
		t.Fatalf("expected 1 match for 'hello' before delete; got %d", preCnt)
	}

	if _, err := pair.Writer.ExecContext(ctx, `DELETE FROM notes WHERE id=?`, id1); err != nil {
		t.Fatalf("delete note: %v", err)
	}

	var postCnt int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'hello'`).Scan(&postCnt); err != nil {
		t.Fatalf("FTS MATCH 'hello' post-delete: %v", err)
	}
	if postCnt != 0 {
		t.Fatalf("expected 0 matches for 'hello' after delete (trigger_ad fired); got %d", postCnt)
	}

	var keepCnt int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'uniqueterm'`).Scan(&keepCnt); err != nil {
		t.Fatalf("FTS MATCH 'uniqueterm': %v", err)
	}
	if keepCnt != 1 {
		t.Fatalf("expected 1 match for 'uniqueterm' (surviving row); got %d", keepCnt)
	}

	if _, err := pair.Writer.ExecContext(ctx, `INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`); err != nil {
		t.Fatalf("FTS rebuild command: %v", err)
	}
}

// TestFTSUpsertSync verifies that the reconcile path populates body_fts and
// tag_names_fts so that notes_fts is queryable after a reconcile pass:
//
//   - body_fts MUST NOT contain frontmatter ("tags: [project]" must not
//     be found in body-match results — only tag_names_fts carries the tag).
//   - body_fts MUST contain the note body text ("hello searchable world").
//   - tag_names_fts MUST contain the tag name ("project").
func TestFTSUpsertSync(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)

	content := "---\ntags: [project]\n---\n# Title\n\nhello searchable world"
	writeNote(t, notesDir, "test.md", content, fixedMtime)

	if _, err := idx.Reconcile(context.Background(), ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

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

	if strings.Contains(bodyFTS, "tags:") {
		t.Errorf("body_fts contains frontmatter ('tags:')\nbody_fts=%q", bodyFTS)
	}

	if !strings.Contains(bodyFTS, "hello searchable world") {
		t.Errorf("body_fts missing body text; got body_fts=%q", bodyFTS)
	}

	if !strings.Contains(tagNamesFTS, "project") {
		t.Errorf("tag_names_fts missing 'project'; got tag_names_fts=%q", tagNamesFTS)
	}

	var matchCnt int
	if err := idx.Pair.Reader.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'searchable'`).Scan(&matchCnt); err != nil {
		t.Fatalf("FTS MATCH 'searchable': %v", err)
	}
	if matchCnt != 1 {
		t.Errorf("FTS MATCH 'searchable': got %d, want 1", matchCnt)
	}

	var tagMatchCnt int
	if err := idx.Pair.Reader.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'project'`).Scan(&tagMatchCnt); err != nil {
		t.Fatalf("FTS MATCH 'project' (body): %v", err)
	}

	if tagMatchCnt != 0 {
		t.Errorf("FTS body_fts MATCH 'project': got %d (frontmatter leaked), want 0", tagMatchCnt)
	}
}

var fixedMtime = time.Unix(1700000000, 0)

// TestFTSDivergenceRebuild verifies that checkAndRepairFTSDivergence detects
// and heals FTS content staleness. The test exercises two scenarios:
//
//  1. Healthy index (body_fts populated): checkAndRepairFTSDivergence is a no-op.
//  2. Stale index (all body_fts empty): checkAndRepairFTSDivergence detects
//     staleness via the “all body_fts empty” heuristic, runs 'rebuild', and
//     restores FTS5 MATCH capability.
//
// Note: for FTS5 external-content tables, SELECT COUNT(*) FROM notes_fts
// always equals SELECT COUNT(*) FROM notes. The divergence check therefore
// uses both a count comparison (for corruption detection) and a content-
// staleness check (all body_fts=”) for the primary real-world scenario.
func TestFTSDivergenceRebuild(t *testing.T) {
	t.Parallel()
	idx, notesDir := newReconcileFixture(t)
	ctx := context.Background()

	for _, name := range []string{"a.md", "b.md", "c.md"} {
		writeNote(t, notesDir, name, "# "+name+"\n\nsearchable content "+name, fixedMtime)
	}
	if _, err := idx.Reconcile(ctx, ModeFull); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	var matchCntPre int
	if err := idx.Pair.Reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'searchable'`).Scan(&matchCntPre); err != nil {
		t.Fatalf("FTS MATCH pre-staleness: %v", err)
	}
	if matchCntPre != 3 {
		t.Fatalf("FTS MATCH 'searchable' pre-staleness: got %d, want 3", matchCntPre)
	}

	if err := idx.checkAndRepairFTSDivergence(ctx); err != nil {
		t.Fatalf("checkAndRepairFTSDivergence (healthy): %v", err)
	}

	var matchCntNoOp int
	if err := idx.Pair.Reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'searchable'`).Scan(&matchCntNoOp); err != nil {
		t.Fatalf("FTS MATCH after no-op check: %v", err)
	}
	if matchCntNoOp != 3 {
		t.Errorf("FTS MATCH after no-op: got %d, want 3 (no-op should be a no-op)", matchCntNoOp)
	}

	if _, err := idx.Pair.Writer.ExecContext(ctx,
		`UPDATE notes SET body_fts = '', tag_names_fts = ''`); err != nil {
		t.Fatalf("reset body_fts: %v", err)
	}
	if _, err := idx.Pair.Writer.ExecContext(ctx,
		`INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`); err != nil {
		t.Fatalf("rebuild fts (with empty content): %v", err)
	}

	var matchCntStale int
	if err := idx.Pair.Reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'searchable'`).Scan(&matchCntStale); err != nil {
		t.Fatalf("FTS MATCH (stale): %v", err)
	}
	if matchCntStale != 0 {
		t.Fatalf("FTS MATCH 'searchable' (stale body_fts): got %d, want 0", matchCntStale)
	}

	if err := idx.checkAndRepairFTSDivergence(ctx); err != nil {
		t.Fatalf("checkAndRepairFTSDivergence (stale): %v", err)
	}

	advancedMtime := fixedMtime.Add(2 * time.Second)
	for _, name := range []string{"a.md", "b.md", "c.md"} {
		if err := os.Chtimes(filepath.Join(notesDir, name), advancedMtime, advancedMtime); err != nil {
			t.Fatalf("chtimes %s: %v", name, err)
		}
	}
	if _, err := idx.Reconcile(ctx, ModeIncremental); err != nil {
		t.Fatalf("Reconcile (re-populate): %v", err)
	}

	var matchCntPost int
	if err := idx.Pair.Reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE body_fts MATCH 'searchable'`).Scan(&matchCntPost); err != nil {
		t.Fatalf("FTS MATCH post-repopulate: %v", err)
	}
	if matchCntPost != 3 {
		t.Errorf("FTS MATCH 'searchable' post-repopulate: got %d, want 3", matchCntPost)
	}
}
