package firstrun

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

// schemaForGrants creates a minimal mcp_write_grants table for the
// round-trip + idempotency tests. Mirrors backend/migrations/004_mcp_grants.sql
// (columns folder_path, level, granted_at, granted_via). STRICT is omitted —
// not load-bearing for these tests, and modernc.org/sqlite supports both.
const schemaForGrants = `
CREATE TABLE mcp_write_grants (
    id           INTEGER PRIMARY KEY,
    folder_path  TEXT    NOT NULL UNIQUE,
    level        INTEGER NOT NULL CHECK (level IN (1, 2)),
    granted_at   INTEGER NOT NULL,
    granted_via  TEXT    NOT NULL DEFAULT 'tree-menu'
)`

// TestApplySeedGrants_RoundTrip mitigates Plan 03b Blocker 5 / threat
// T-09-03b-06: write at canonical root, read at canonical root, same
// vault.SeedGrantsPath helper on both sides → no path mismatch.
func TestApplySeedGrants_RoundTrip(t *testing.T) {
	dataDir := t.TempDir()
	// Mkdir <dataDir>/.jasper first — production lifecycle does this
	// before applying; we mirror.
	if err := os.MkdirAll(filepath.Join(dataDir, vault.SubdirName), 0o700); err != nil {
		t.Fatalf("mkdir .jasper: %v", err)
	}

	// Write seed_grants.json via the same path helper production uses.
	grants := []SetupGrantSeed{{Folder: "ai-zone", Level: 2}}
	raw, err := json.Marshal(grants)
	if err != nil {
		t.Fatalf("marshal grants: %v", err)
	}
	if err := os.WriteFile(vault.SeedGrantsPath(dataDir), raw, 0o600); err != nil {
		t.Fatalf("write seed_grants.json: %v", err)
	}

	// Open a tiny in-memory DB and seed the schema.
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(schemaForGrants); err != nil {
		t.Fatalf("create mcp_write_grants: %v", err)
	}

	// Apply.
	if err := ApplySeedGrants(context.Background(), db, dataDir); err != nil {
		t.Fatalf("ApplySeedGrants: %v", err)
	}

	// Assert: row inserted.
	var folder string
	var level int
	var grantedVia string
	if err := db.QueryRow("SELECT folder_path, level, granted_via FROM mcp_write_grants").Scan(&folder, &level, &grantedVia); err != nil {
		t.Fatalf("query mcp_write_grants: %v", err)
	}
	if folder != "ai-zone" || level != 2 {
		t.Fatalf("unexpected row: folder=%q level=%d", folder, level)
	}
	if grantedVia != "wizard" {
		t.Fatalf("expected granted_via=wizard, got %q", grantedVia)
	}

	// Assert: file deleted.
	if _, err := os.Stat(vault.SeedGrantsPath(dataDir)); !os.IsNotExist(err) {
		t.Fatalf("seed_grants.json should be deleted; stat err=%v", err)
	}

	// Idempotency: second call is a no-op (file is gone).
	if err := ApplySeedGrants(context.Background(), db, dataDir); err != nil {
		t.Fatalf("ApplySeedGrants (idempotent call): %v", err)
	}
}

// TestApplySeedGrants_NoFile asserts the idempotent no-op when the queue
// file is absent — the common path on every boot of an established vault.
func TestApplySeedGrants_NoFile(t *testing.T) {
	dataDir := t.TempDir()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer func() { _ = db.Close() }()
	if err := ApplySeedGrants(context.Background(), db, dataDir); err != nil {
		t.Fatalf("ApplySeedGrants on empty dataDir: %v", err)
	}
}

// TestApplySeedGrants_BadJSON asserts that a corrupt queue file returns
// a wrapped error and is NOT deleted (operator must inspect manually).
func TestApplySeedGrants_BadJSON(t *testing.T) {
	dataDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataDir, vault.SubdirName), 0o700); err != nil {
		t.Fatalf("mkdir .jasper: %v", err)
	}
	path := vault.SeedGrantsPath(dataDir)
	if err := os.WriteFile(path, []byte("{ not valid json"), 0o600); err != nil {
		t.Fatalf("write bad json: %v", err)
	}

	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(schemaForGrants); err != nil {
		t.Fatalf("create mcp_write_grants: %v", err)
	}

	if err := ApplySeedGrants(context.Background(), db, dataDir); err == nil {
		t.Fatalf("expected error for malformed JSON, got nil")
	}

	// File should still be there for operator inspection.
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("seed_grants.json should NOT be deleted on JSON decode error; stat err=%v", err)
	}
}
