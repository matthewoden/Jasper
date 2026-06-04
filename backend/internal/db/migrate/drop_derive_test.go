package migrate

import (
	"strings"
	"testing"
	"testing/fstest"

	"github.com/matthewoden/jasper/backend/migrations"
)

// TestDeriveDropStatements_ProductionMigrations is a regression guard
// for the v1.0 admin-reindex bug (resolved in commit 0240d36): every
// CREATE TABLE in every embedded migration MUST be reachable from the
// derived drop list. New migrations that introduce tables are
// automatically picked up — no manual list maintenance.
func TestDeriveDropStatements_ProductionMigrations(t *testing.T) {
	stmts, err := deriveDropStatements(migrations.FS)
	if err != nil {
		t.Fatalf("deriveDropStatements(production FS): %v", err)
	}
	if len(stmts) == 0 {
		t.Fatalf("expected at least one DROP TABLE statement, got 0")
	}

	// Tables we know exist in v1.0 migrations 001–004.
	mustContain := []string{
		"notes",             // 001_initial.sql
		"schema_migrations", // 001_initial.sql
		"tags",              // 002_tags_backlinks.sql
		"note_tags",         // 002_tags_backlinks.sql
		"backlinks",         // 002_tags_backlinks.sql
		"notes_fts",         // 003_fts.sql
		"mcp_write_grants",  // 004_mcp_grants.sql
	}
	for _, want := range mustContain {
		found := false
		for _, s := range stmts {
			if s == "DROP TABLE IF EXISTS "+want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("expected DROP TABLE IF EXISTS %s in derived list; got: %v", want, stmts)
		}
	}

	// schema_migrations MUST be last — 001_initial.sql creates it, so
	// re-running 001 against a kept-but-truncated schema_migrations
	// would fail on a duplicate CREATE TABLE.
	if last := stmts[len(stmts)-1]; last != "DROP TABLE IF EXISTS schema_migrations" {
		t.Errorf("schema_migrations must drop last; got last=%q", last)
	}
}

// TestDeriveDropStatements_OrderingNewestFirst proves that when
// migration A creates table T1 and a later migration B creates table T2
// (e.g. T2 has a foreign key into T1), the derived list drops T2 before
// T1 — the required order for FK-cascade safety on rebuild.
func TestDeriveDropStatements_OrderingNewestFirst(t *testing.T) {
	mock := fstest.MapFS{
		"001_first.sql": {Data: []byte(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY);
CREATE TABLE parent_table (id INTEGER PRIMARY KEY);`)},
		"002_second.sql": {Data: []byte(`CREATE TABLE child_table (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent_table(id));`)},
	}
	stmts, err := deriveDropStatements(mock)
	if err != nil {
		t.Fatalf("deriveDropStatements: %v", err)
	}

	// child_table (from 002) must appear before parent_table (from 001).
	posChild := indexOf(stmts, "DROP TABLE IF EXISTS child_table")
	posParent := indexOf(stmts, "DROP TABLE IF EXISTS parent_table")
	posSchema := indexOf(stmts, "DROP TABLE IF EXISTS schema_migrations")
	if posChild < 0 || posParent < 0 || posSchema < 0 {
		t.Fatalf("missing expected drops; got: %v", stmts)
	}
	if posChild >= posParent {
		t.Errorf("child_table must drop before parent_table (FK order); got child=%d parent=%d", posChild, posParent)
	}
	if posSchema != len(stmts)-1 {
		t.Errorf("schema_migrations must be last; got pos=%d len=%d", posSchema, len(stmts))
	}
}

// TestDeriveDropStatements_VirtualTable verifies that CREATE VIRTUAL
// TABLE (used by FTS5 in 003_fts.sql) is parsed identically to
// CREATE TABLE.
func TestDeriveDropStatements_VirtualTable(t *testing.T) {
	mock := fstest.MapFS{
		"001_initial.sql": {Data: []byte(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY);
CREATE TABLE notes (id TEXT PRIMARY KEY);`)},
		"002_fts.sql": {Data: []byte(`CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, content='notes');`)},
	}
	stmts, err := deriveDropStatements(mock)
	if err != nil {
		t.Fatalf("deriveDropStatements: %v", err)
	}
	if !contains(stmts, "DROP TABLE IF EXISTS notes_fts") {
		t.Errorf("expected DROP of virtual table notes_fts; got: %v", stmts)
	}
	// notes_fts (002) must drop before notes (001) — FTS5 content= bind.
	if indexOf(stmts, "DROP TABLE IF EXISTS notes_fts") >= indexOf(stmts, "DROP TABLE IF EXISTS notes") {
		t.Errorf("notes_fts must drop before notes; got: %v", stmts)
	}
}

// TestDeriveDropStatements_IfNotExists confirms `CREATE TABLE IF NOT
// EXISTS` form is matched. 001_initial.sql uses this form for
// schema_migrations.
func TestDeriveDropStatements_IfNotExists(t *testing.T) {
	mock := fstest.MapFS{
		"001_initial.sql": {Data: []byte(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY);
CREATE TABLE notes (id TEXT PRIMARY KEY);`)},
	}
	stmts, err := deriveDropStatements(mock)
	if err != nil {
		t.Fatalf("deriveDropStatements: %v", err)
	}
	if !contains(stmts, "DROP TABLE IF EXISTS schema_migrations") {
		t.Errorf("CREATE TABLE IF NOT EXISTS not matched; got: %v", stmts)
	}
}

// TestDeriveDropStatements_IgnoresIndexAndTrigger confirms that
// CREATE INDEX / CREATE TRIGGER are NOT included in the drop list —
// dropping the underlying table cascades.
func TestDeriveDropStatements_IgnoresIndexAndTrigger(t *testing.T) {
	mock := fstest.MapFS{
		"001_initial.sql": {Data: []byte(`CREATE TABLE notes (id TEXT PRIMARY KEY);
CREATE INDEX idx_notes_id ON notes(id);
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN SELECT 1; END;
CREATE TABLE schema_migrations (version TEXT PRIMARY KEY);`)},
	}
	stmts, err := deriveDropStatements(mock)
	if err != nil {
		t.Fatalf("deriveDropStatements: %v", err)
	}
	for _, s := range stmts {
		if strings.Contains(s, "idx_notes_id") || strings.Contains(s, "notes_au") {
			t.Errorf("CREATE INDEX/TRIGGER leaked into drop list: %q", s)
		}
	}
}

// TestDeriveDropStatements_EmptyMigrationsReturnsError catches the
// degenerate case where the embed FS produces nothing parseable — better
// to surface than to silently no-op and let applyAll fail later.
func TestDeriveDropStatements_EmptyMigrationsReturnsError(t *testing.T) {
	mock := fstest.MapFS{
		// A migration file with no CREATE TABLE statements at all.
		"001_pragmas_only.sql": {Data: []byte(`PRAGMA foreign_keys=ON;`)},
	}
	_, err := deriveDropStatements(mock)
	if err == nil {
		t.Fatalf("expected error for migrations containing no CREATE TABLE; got nil")
	}
	if !strings.Contains(err.Error(), "no CREATE TABLE") {
		t.Errorf("error should mention 'no CREATE TABLE'; got: %v", err)
	}
}

func indexOf(haystack []string, needle string) int {
	for i, s := range haystack {
		if s == needle {
			return i
		}
	}
	return -1
}

func contains(haystack []string, needle string) bool {
	return indexOf(haystack, needle) >= 0
}
