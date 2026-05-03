// Package migrations embeds the SQL migration files for the
// jasper SQLite derived index. Files are discovered by Plan 02-03's
// runner via fs.ReadDir on FS. Filenames must match
// [0-9]{3}_[a-z_]+.sql (sorted lexicographically = applied in order).
//
// Per DESIGN.md §4.2, the embedded *.sql files are the ONLY source
// of schema changes — there is no "ad-hoc ALTER TABLE on first
// boot" path. Adding a column means adding a new migration file
// (002_*, 003_*, ...).
package migrations

import "embed"

// FS holds every migrations/*.sql file. Files in this directory are the
// ONLY source of schema changes — DESIGN.md §4.2.
//
//go:embed *.sql
var FS embed.FS
