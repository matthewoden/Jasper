package sqlite

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestApplyConnectionPragmas_AllSucceed(t *testing.T) {
	t.Parallel()

	// Use a real on-disk database (not :memory:) so journal_mode=WAL
	// can succeed — WAL on :memory: silently falls back to MEMORY
	// because there is no on-disk file to host the WAL log.
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "pragmas.db")

	db, err := sql.Open("sqlite", "file:"+dbPath)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer func() { _ = db.Close() }()

	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("db.Conn: %v", err)
	}
	defer func() { _ = conn.Close() }()

	if err := applyConnectionPragmas(ctx, conn); err != nil {
		t.Fatalf("applyConnectionPragmas: %v", err)
	}

	// Verify each pragma landed.
	checks := []struct {
		name string
		want any
	}{
		{"journal_mode", "wal"},
		{"synchronous", int64(1)},
		{"busy_timeout", int64(5000)},
		{"wal_autocheckpoint", int64(1000)},
		{"foreign_keys", int64(1)},
	}
	for _, c := range checks {
		c := c
		t.Run(c.name, func(t *testing.T) {
			var got any
			if err := conn.QueryRowContext(ctx, "PRAGMA "+c.name).Scan(&got); err != nil {
				t.Fatalf("PRAGMA %s: %v", c.name, err)
			}
			switch want := c.want.(type) {
			case string:
				gotStr, ok := got.(string)
				if !ok {
					t.Fatalf("PRAGMA %s scan type = %T, want string", c.name, got)
				}
				if !strings.EqualFold(gotStr, want) {
					t.Errorf("PRAGMA %s = %q, want %q", c.name, gotStr, want)
				}
			case int64:
				gotInt, ok := got.(int64)
				if !ok {
					t.Fatalf("PRAGMA %s scan type = %T, want int64", c.name, got)
				}
				if gotInt != want {
					t.Errorf("PRAGMA %s = %d, want %d", c.name, gotInt, want)
				}
			}
		})
	}
}

func TestPragmas_ConstSliceShape(t *testing.T) {
	t.Parallel()

	if len(Pragmas) < 4 {
		t.Errorf("len(Pragmas) = %d, want >= 4", len(Pragmas))
	}

	requiredLiterals := []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL",
		"PRAGMA busy_timeout=5000",
		"PRAGMA wal_autocheckpoint=1000",
	}
	for _, want := range requiredLiterals {
		found := false
		for _, p := range Pragmas {
			if p == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("Pragmas missing required literal %q", want)
		}
	}
}
