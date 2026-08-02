// Package sqlite is the writer/reader-split access layer for the derived index.
// The filesystem is the source of truth (ADR-0001); wiping this database is
// never data loss.
//
// Pragmas are applied twice — via the DSN, then again after Ping — because a
// DSN pragma the driver silently ignores would otherwise go unnoticed.
package sqlite

import (
	"context"
	"database/sql"
	"fmt"
)

// Pragmas is applied to every connection on open. Order matters:
// journal_mode=WAL must be first so the rest land against a WAL database, and
// busy_timeout after it so any BEGIN in an open path gets the wait window.
// foreign_keys=ON is explicit so nothing depends on the driver's default.
var Pragmas = []string{
	"PRAGMA journal_mode=WAL",
	"PRAGMA synchronous=NORMAL",
	"PRAGMA busy_timeout=5000",
	"PRAGMA wal_autocheckpoint=1000",
	"PRAGMA foreign_keys=ON",
}

func applyConnectionPragmas(ctx context.Context, conn *sql.Conn) error {
	for _, p := range Pragmas {
		if _, err := conn.ExecContext(ctx, p); err != nil {
			return fmt.Errorf("apply pragma %q: %w", p, err)
		}
	}
	return nil
}
