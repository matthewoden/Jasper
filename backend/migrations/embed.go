// Package migrations embeds the SQL migration files for the jasper
// SQLite derived index. Filenames must match [0-9]{3}_[a-z_]+.sql;
// lexicographic sort order is application order.
//
// The embedded *.sql files are the ONLY source of schema changes —
// there is no ad-hoc ALTER TABLE path. Adding a column means adding
// a new migration file.
package migrations

import "embed"

// FS holds every migrations/*.sql file.
//
//go:embed *.sql
var FS embed.FS
