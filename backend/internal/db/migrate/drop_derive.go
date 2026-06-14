package migrate

import (
	"fmt"
	"io/fs"
	"regexp"
	"sort"
)

var createTablePattern = regexp.MustCompile(
	`(?i)create\s+(?:temp(?:orary)?\s+)?(?:virtual\s+)?table\s+(?:if\s+not\s+exists\s+)?` +
		`["` + "`" + `]?([a-z_][a-z0-9_]*)["` + "`" + `]?`,
)

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

	for i := len(names) - 1; i >= 0; i-- {
		body, err := fs.ReadFile(migrations, names[i])
		if err != nil {
			return nil, fmt.Errorf("read migration %q: %w", names[i], err)
		}
		matches := createTablePattern.FindAllSubmatch(body, -1)

		for j := len(matches) - 1; j >= 0; j-- {
			tbl := string(matches[j][1])
			if tbl == "schema_migrations" {
				schemaMigrationsTable = tbl
				continue
			}
			stmts = append(stmts, "DROP TABLE IF EXISTS "+tbl)
		}
	}

	if schemaMigrationsTable != "" {
		stmts = append(stmts, "DROP TABLE IF EXISTS "+schemaMigrationsTable)
	}

	if len(stmts) == 0 {
		return nil, fmt.Errorf("derive drop statements: no CREATE TABLE found in any migration (FS contains %d files)", len(names))
	}
	return stmts, nil
}
