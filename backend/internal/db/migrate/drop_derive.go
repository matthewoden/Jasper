package migrate

import (
	"fmt"
	"io/fs"
	"regexp"
	"sort"
)

// createTablePattern matches every `CREATE TABLE` and `CREATE VIRTUAL
// TABLE` declaration in a migration .sql file, capturing the table
// name (group 1). Case-insensitive, allows optional `IF NOT EXISTS`,
// allows the SQLite `temp`/`temporary` qualifier (we never use it but
// the parser shouldn't choke on it).
//
// Matches:
//   - `CREATE TABLE notes (...)`
//   - `CREATE TABLE IF NOT EXISTS schema_migrations (...)`
//   - `CREATE VIRTUAL TABLE notes_fts USING fts5(...)`
//
// Does NOT match `CREATE INDEX`, `CREATE TRIGGER`, `CREATE VIEW` — those
// don't need explicit DROP because dropping the underlying table cascades.
var createTablePattern = regexp.MustCompile(
	`(?i)create\s+(?:temp(?:orary)?\s+)?(?:virtual\s+)?table\s+(?:if\s+not\s+exists\s+)?` +
		`["` + "`" + `]?([a-z_][a-z0-9_]*)["` + "`" + `]?`)

// deriveDropStatements parses the embedded migrations and returns a
// DROP TABLE IF EXISTS list ordered for safe execution by
// RebuildAndReindex.
//
// Order:
//  1. Newest migration's tables first, oldest migration's tables last.
//     Because migrations are append-only and downstream tables (FK
//     dependents, FTS5 `content=`-bound tables) live in newer
//     migrations than their parents, reverse-migration order is the
//     correct dependency order.
//  2. Within a single migration, declarations are dropped in REVERSE
//     declaration order — same dependents-first principle at the file
//     scope.
//  3. `schema_migrations` (created by 001_initial.sql) is always last.
//     It is dropped — not truncated — because re-running 001 would
//     fail on a duplicate CREATE TABLE if we kept the table around.
//
// Replaces the prior hardcoded `dropStatements` list in
// RebuildAndReindex. The hardcoded list caused the v1.0 admin-reindex
// regression (commit 0240d36): Phase 8's `004_mcp_grants.sql` added
// `mcp_write_grants` but the list was never updated, so rebuild fell
// through to Path 3 (ErrUnrecoverable) on a duplicate CREATE TABLE.
// Deriving from the migrations themselves makes that whole class of
// bug structurally impossible.
func deriveDropStatements(migrations fs.FS) ([]string, error) {
	entries, err := fs.ReadDir(migrations, ".")
	if err != nil {
		return nil, fmt.Errorf("read migrations FS: %w", err)
	}

	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := e.Name()
		if !migrationFilenamePattern.MatchString(n) {
			return nil, fmt.Errorf("migration filename %q does not match %q", n, migrationFilenamePattern.String())
		}
		names = append(names, n)
	}
	sort.Strings(names)

	stmts := make([]string, 0, len(names)*2)
	var schemaMigrationsTable string

	// Walk migrations newest → oldest.
	for i := len(names) - 1; i >= 0; i-- {
		body, err := fs.ReadFile(migrations, names[i])
		if err != nil {
			return nil, fmt.Errorf("read migration %q: %w", names[i], err)
		}
		matches := createTablePattern.FindAllSubmatch(body, -1)
		// Reverse within-file order so later declarations drop first.
		for j := len(matches) - 1; j >= 0; j-- {
			tbl := string(matches[j][1])
			if tbl == "schema_migrations" {
				schemaMigrationsTable = tbl
				continue
			}
			stmts = append(stmts, "DROP TABLE IF EXISTS "+tbl)
		}
	}

	// schema_migrations always drops last — see godoc above.
	if schemaMigrationsTable != "" {
		stmts = append(stmts, "DROP TABLE IF EXISTS "+schemaMigrationsTable)
	}

	if len(stmts) == 0 {
		return nil, fmt.Errorf("derive drop statements: no CREATE TABLE found in any migration (FS contains %d files)", len(names))
	}
	return stmts, nil
}
