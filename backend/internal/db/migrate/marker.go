package migrate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Marker reports whether the one-time data migration name has recorded its
// completion in schema_migrations.
func Marker(ctx context.Context, db *sql.DB, name string) (bool, error) {
	var version string
	err := db.QueryRowContext(ctx, `SELECT version FROM schema_migrations WHERE version = ?`, name).Scan(&version)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, sql.ErrNoRows):
		return false, nil
	default:
		return false, fmt.Errorf("check marker %s: %w", name, err)
	}
}

// RecordMarker records that the one-time data migration name has completed.
func RecordMarker(ctx context.Context, db *sql.DB, name string) error {
	if _, err := db.ExecContext(ctx,
		`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`, name, time.Now().Unix()); err != nil {
		return fmt.Errorf("record marker %s: %w", name, err)
	}
	return nil
}
