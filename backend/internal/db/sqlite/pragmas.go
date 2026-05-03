// Package sqlite is the writer/reader-split SQLite access layer for the
// Jasper derived index (DATA-02..05). The filesystem is the source of
// truth (DATA-01); every row in this database is reconstructable by
// walking the notes/ directory. Wiping the SQLite file is never data
// loss — see DESIGN.md §4.4.
//
// This file holds the canonical pragma list. The pragmas are applied
// twice: once via the DSN _pragma= query parameters parsed by
// modernc.org/sqlite, and once again as defense-in-depth via
// applyConnectionPragmas after Ping. The DSN approach is the
// driver-supported "every new connection gets these" path; the
// post-Ping path catches any silently-ignored DSN pragmas.
package sqlite

import (
	"context"
	"database/sql"
	"fmt"
)

// Pragmas is the locked DATA-04 pragma list applied to every connection
// (writer or reader) on open. The slice is exported so tests can iterate
// it identically.
//
// The order matters slightly: journal_mode=WAL must be first so the rest
// of the pragmas land against a database in WAL mode. busy_timeout is
// applied after WAL so any subsequent BEGIN inside open paths gets the
// 5s wait window. foreign_keys=ON is the SQLite default in many
// environments but is explicit here so the project never depends on the
// driver's default.
var Pragmas = []string{
	"PRAGMA journal_mode=WAL",
	"PRAGMA synchronous=NORMAL",
	"PRAGMA busy_timeout=5000",
	"PRAGMA wal_autocheckpoint=1000",
	"PRAGMA foreign_keys=ON",
}

// applyConnectionPragmas runs each Pragmas statement against conn,
// returning the first error wrapped with context. Used as
// defense-in-depth after Open's Ping in case the DSN-level _pragma=
// alias was silently ignored by an older driver build.
func applyConnectionPragmas(ctx context.Context, conn *sql.Conn) error {
	for _, p := range Pragmas {
		if _, err := conn.ExecContext(ctx, p); err != nil {
			return fmt.Errorf("apply pragma %q: %w", p, err)
		}
	}
	return nil
}
