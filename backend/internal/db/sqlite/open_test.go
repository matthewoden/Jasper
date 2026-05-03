package sqlite

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newTestPair opens a Pair against <tempdir>/app.db and registers a
// Cleanup to close it. Returns the open Pair and the absolute db path.
func newTestPair(t *testing.T) (*Pair, string) {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "app.db")
	ctx := context.Background()
	pair, err := Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("Open(%q) returned error: %v", dbPath, err)
	}
	t.Cleanup(func() {
		if err := pair.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return pair, dbPath
}

func TestOpen_FreshDB(t *testing.T) {
	t.Parallel()
	pair, dbPath := newTestPair(t)

	if pair.Writer == nil {
		t.Fatal("pair.Writer is nil")
	}
	if pair.Reader == nil {
		t.Fatal("pair.Reader is nil")
	}

	// MaxOpenConns(1) is the writer-serialization invariant from
	// DATA-03 — the test asserts the *sql.DB exposes it via Stats so
	// any future regression that changes the SetMaxOpenConns value
	// fails here loudly.
	stats := pair.Writer.Stats()
	if stats.MaxOpenConnections != 1 {
		t.Errorf("writer MaxOpenConnections = %d, want 1", stats.MaxOpenConnections)
	}

	// File should exist on disk after the first connection (Ping
	// triggers the driver to create it).
	if _, err := os.Stat(dbPath); err != nil {
		t.Errorf("expected db file at %q: %v", dbPath, err)
	}
}

func TestOpen_RejectsRelativePath(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	_, err := Open(ctx, "app.db")
	if err == nil {
		t.Fatal("Open with relative path returned nil error, want error")
	}
	if !strings.Contains(err.Error(), "must be absolute") {
		t.Errorf("error = %v, want substring %q", err, "must be absolute")
	}
}

func TestOpen_PragmasActive_BothHalves(t *testing.T) {
	t.Parallel()
	pair, _ := newTestPair(t)
	ctx := context.Background()

	cases := []struct {
		name string
		db   *sql.DB
	}{
		{"writer", pair.Writer},
		{"reader", pair.Reader},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			assertPragma(ctx, t, c.db, "journal_mode", "wal")
			assertPragmaInt(ctx, t, c.db, "synchronous", 1) // NORMAL = 1
			assertPragmaInt(ctx, t, c.db, "busy_timeout", 5000)
			assertPragmaInt(ctx, t, c.db, "wal_autocheckpoint", 1000)
			assertPragmaInt(ctx, t, c.db, "foreign_keys", 1)
		})
	}
}

func TestPair_BeginImmediate(t *testing.T) {
	t.Parallel()
	pair, _ := newTestPair(t)
	ctx := context.Background()

	// Bootstrap a table on the writer.
	if _, err := pair.Writer.ExecContext(ctx, `CREATE TABLE foo (id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatalf("create table: %v", err)
	}

	tx, err := pair.BeginImmediate(ctx)
	if err != nil {
		t.Fatalf("BeginImmediate: %v", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO foo(id) VALUES (1)`); err != nil {
		_ = tx.Rollback()
		t.Fatalf("insert: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}

	// Read from the Reader half — proves the writer's commit is
	// visible across the pool boundary (WAL).
	var n int
	if err := pair.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM foo`).Scan(&n); err != nil {
		t.Fatalf("select: %v", err)
	}
	if n != 1 {
		t.Errorf("count = %d, want 1", n)
	}
}

func TestPair_Close_Idempotent(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "app.db")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pair, err := Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := pair.Close(); err != nil {
		t.Errorf("first Close: %v", err)
	}
	// A second Close on database/sql.DB is documented to return an
	// error (DB already closed). We don't assert nil here — only
	// assert that calling Close does not panic.
	_ = pair.Close()
}

// assertPragma queries `PRAGMA <name>` on db and asserts the string
// result equals want (case-insensitive — SQLite returns "wal" lower
// but verifying with EqualFold matches our verifier semantics).
func assertPragma(ctx context.Context, t *testing.T, db *sql.DB, name, want string) {
	t.Helper()
	var got string
	if err := db.QueryRowContext(ctx, "PRAGMA "+name).Scan(&got); err != nil {
		t.Fatalf("PRAGMA %s: %v", name, err)
	}
	if !strings.EqualFold(got, want) {
		t.Errorf("PRAGMA %s = %q, want %q", name, got, want)
	}
}

// assertPragmaInt queries `PRAGMA <name>` on db and asserts the integer
// result equals want.
func assertPragmaInt(ctx context.Context, t *testing.T, db *sql.DB, name string, want int) {
	t.Helper()
	var got int
	if err := db.QueryRowContext(ctx, "PRAGMA "+name).Scan(&got); err != nil {
		t.Fatalf("PRAGMA %s: %v", name, err)
	}
	if got != want {
		t.Errorf("PRAGMA %s = %d, want %d", name, got, want)
	}
}
