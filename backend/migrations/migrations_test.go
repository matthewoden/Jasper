// Package migrations_test verifies that all embedded migration SQL files
// apply cleanly and produce the expected schema in a real SQLite database.
//
// TDD: RED tests written first (Plan 06-02 Task 2); they turn GREEN once
// 002_tags_backlinks.sql is created.
package migrations_test

import (
	"context"
	"database/sql"
	"io/fs"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/matthewoden/jasper/backend/migrations"
)

// openTestDB opens a fresh on-disk SQLite database in t.TempDir() with
// foreign-key enforcement enabled, applies all provided SQL bytes in
// order, and returns the open *sql.DB. The caller must not close it —
// t.Cleanup handles that.
func openTestDB(t *testing.T, sqls ...string) *sql.DB {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	dsn := "file:" + dbPath + "?_pragma=foreign_keys(ON)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// Apply each SQL block in order (mimicking the migration runner).
	for i, s := range sqls {
		if _, err := db.ExecContext(context.Background(), s); err != nil {
			t.Fatalf("exec sql[%d]: %v", i, err)
		}
	}
	return db
}

// readMigration reads a named file from migrations.FS and returns its contents.
func readMigration(t *testing.T, name string) string {
	t.Helper()
	data, err := migrations.FS.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(data)
}

// TestMigration002_TablesCreated verifies that applying both migrations
// creates the tags, note_tags, and backlinks tables.
func TestMigration002_TablesCreated(t *testing.T) {
	sql001 := readMigration(t, "001_initial.sql")
	sql002 := readMigration(t, "002_tags_backlinks.sql")
	db := openTestDB(t, sql001, sql002)

	const query = `
SELECT count(*) FROM sqlite_master
WHERE type='table' AND name IN ('tags', 'note_tags', 'backlinks')`
	var count int
	if err := db.QueryRowContext(context.Background(), query).Scan(&count); err != nil {
		t.Fatalf("count tables: %v", err)
	}
	if count != 3 {
		t.Errorf("expected 3 tables (tags, note_tags, backlinks), got %d", count)
	}
}

// TestMigration002_IndicesCreated verifies that the three required indices exist.
func TestMigration002_IndicesCreated(t *testing.T) {
	sql001 := readMigration(t, "001_initial.sql")
	sql002 := readMigration(t, "002_tags_backlinks.sql")
	db := openTestDB(t, sql001, sql002)

	const query = `
SELECT name FROM sqlite_master
WHERE type='index' AND name IN (
  'idx_backlinks_target_id',
  'idx_backlinks_source_id',
  'idx_note_tags_tag_id'
)
ORDER BY name`
	rows, err := db.QueryContext(context.Background(), query)
	if err != nil {
		t.Fatalf("query indices: %v", err)
	}
	defer func() { _ = rows.Close() }()

	var found []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan: %v", err)
		}
		found = append(found, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err: %v", err)
	}

	if len(found) != 3 {
		t.Errorf("expected 3 indices, got %d: %v", len(found), found)
	}
}

// TestMigration002_TagsUniqueConstraint verifies that the tags.name UNIQUE
// constraint rejects duplicate inserts.
func TestMigration002_TagsUniqueConstraint(t *testing.T) {
	sql001 := readMigration(t, "001_initial.sql")
	sql002 := readMigration(t, "002_tags_backlinks.sql")
	db := openTestDB(t, sql001, sql002)

	_, err := db.ExecContext(context.Background(),
		`INSERT INTO tags(name) VALUES('alpha')`)
	if err != nil {
		t.Fatalf("first insert: %v", err)
	}

	_, err = db.ExecContext(context.Background(),
		`INSERT INTO tags(name) VALUES('alpha')`)
	if err == nil {
		t.Error("expected UNIQUE violation on duplicate tag insert, got nil error")
	}
}

// TestMigration002_NoteTagsCascadeDelete verifies that ON DELETE CASCADE
// on note_tags.note_id removes join rows when the parent note is deleted.
func TestMigration002_NoteTagsCascadeDelete(t *testing.T) {
	sql001 := readMigration(t, "001_initial.sql")
	sql002 := readMigration(t, "002_tags_backlinks.sql")
	db := openTestDB(t, sql001, sql002)

	ctx := context.Background()

	// Insert a note row.
	const noteID = "00000000-0000-4000-a000-000000000001"
	_, err := db.ExecContext(ctx, `
		INSERT INTO notes(id, path, title, mtime_unix, size_bytes, checksum_sha256, created_at, updated_at)
		VALUES(?, 'test.md', 'Test', 1000, 0, '', 1000, 1000)`, noteID)
	if err != nil {
		t.Fatalf("insert note: %v", err)
	}

	// Insert a tag and a note_tags join row.
	res, err := db.ExecContext(ctx, `INSERT INTO tags(name) VALUES('mytest')`)
	if err != nil {
		t.Fatalf("insert tag: %v", err)
	}
	tagID, _ := res.LastInsertId()

	_, err = db.ExecContext(ctx,
		`INSERT INTO note_tags(note_id, tag_id) VALUES(?, ?)`, noteID, tagID)
	if err != nil {
		t.Fatalf("insert note_tags: %v", err)
	}

	// Delete the note — note_tags row should cascade.
	if _, err := db.ExecContext(ctx, `DELETE FROM notes WHERE id=?`, noteID); err != nil {
		t.Fatalf("delete note: %v", err)
	}

	var count int
	if err := db.QueryRowContext(ctx,
		`SELECT count(*) FROM note_tags WHERE note_id=?`, noteID,
	).Scan(&count); err != nil {
		t.Fatalf("count note_tags: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0 note_tags rows after note deletion, got %d", count)
	}
}

// TestMigration002_EmbeddedFSListsFile verifies that the embedded migrations.FS
// exposes 002_tags_backlinks.sql so the migration runner will discover it.
func TestMigration002_EmbeddedFSListsFile(t *testing.T) {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	var found bool
	for _, e := range entries {
		if e.Name() == "002_tags_backlinks.sql" {
			found = true
			break
		}
	}
	if !found {
		t.Error("002_tags_backlinks.sql not found in migrations.FS")
	}
}

// applyAllMigrations replays every embedded *.sql file in
// lexicographic order against the test DB so Phase 8 assertions can
// rely on the full migration chain (001+002+003+004).
func applyAllMigrations(t *testing.T) *sql.DB {
	t.Helper()
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatalf("ReadDir migrations.FS: %v", err)
	}
	var sqls []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if len(name) < 4 || name[len(name)-4:] != ".sql" {
			continue
		}
		sqls = append(sqls, readMigration(t, name))
	}
	return openTestDB(t, sqls...)
}

// TestMigration004_McpGrantsTableCreated — Phase 8 D-17: applying all
// embedded migrations creates the mcp_write_grants table.
func TestMigration004_McpGrantsTableCreated(t *testing.T) {
	db := applyAllMigrations(t)

	const query = `
SELECT count(*) FROM sqlite_master
WHERE type='table' AND name='mcp_write_grants'`
	var count int
	if err := db.QueryRowContext(context.Background(), query).Scan(&count); err != nil {
		t.Fatalf("count mcp_write_grants: %v", err)
	}
	if count != 1 {
		t.Errorf("expected mcp_write_grants table, got count=%d", count)
	}
}

// TestMigration004_McpGrantsIndexCreated — Phase 8 D-18 recursive
// resolution walks folder_path, so the supporting index must exist.
func TestMigration004_McpGrantsIndexCreated(t *testing.T) {
	db := applyAllMigrations(t)

	const query = `
SELECT name FROM sqlite_master
WHERE type='index' AND name='idx_mcp_grants_folder'`
	var name string
	if err := db.QueryRowContext(context.Background(), query).Scan(&name); err != nil {
		t.Fatalf("missing idx_mcp_grants_folder: %v", err)
	}
	if name != "idx_mcp_grants_folder" {
		t.Errorf("expected idx_mcp_grants_folder, got %q", name)
	}
}

// TestMigration004_McpGrants_LevelCheckRejectsOutOfBand verifies that
// the STRICT-mode CHECK constraint rejects level values outside {1, 2}.
func TestMigration004_McpGrants_LevelCheckRejectsOutOfBand(t *testing.T) {
	db := applyAllMigrations(t)

	_, err := db.ExecContext(context.Background(), `
INSERT INTO mcp_write_grants(folder_path, level, granted_at, granted_via)
VALUES('projects/x', 3, 0, 'test')`)
	if err == nil {
		t.Fatal("expected CHECK violation for level=3, got nil error")
	}
	if !contains(err.Error(), "CHECK") {
		t.Errorf("error did not mention CHECK constraint: %v", err)
	}
}

// TestMigration004_McpGrants_FolderPathUniqueRejectsDuplicates
// verifies that folder_path UNIQUE rejects duplicate inserts so the
// upsert path in 08-08 has a backstop.
func TestMigration004_McpGrants_FolderPathUniqueRejectsDuplicates(t *testing.T) {
	db := applyAllMigrations(t)

	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `
INSERT INTO mcp_write_grants(folder_path, level, granted_at, granted_via)
VALUES('projects/x', 1, 1700000000, 'wizard')`); err != nil {
		t.Fatalf("first insert: %v", err)
	}
	_, err := db.ExecContext(ctx, `
INSERT INTO mcp_write_grants(folder_path, level, granted_at, granted_via)
VALUES('projects/x', 2, 1700000001, 'tree-context-menu')`)
	if err == nil {
		t.Fatal("expected UNIQUE violation on duplicate folder_path, got nil error")
	}
}

// contains is a local helper that avoids pulling in strings just for
// the error-message sniffs above (keeps the imports list lean).
func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
