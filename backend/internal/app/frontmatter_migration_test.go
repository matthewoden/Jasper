package app

// Tests for InjectFrontmatterScaffoldMigration (Plan 06-06 Task 1).
//
// Tests 1-9 cover:
//  1. Fresh vault with mixed files (2 missing, 1 has frontmatter)
//  2. Already-migrated vault (idempotent second run)
//  3. Partial run resume (D-39 resumability)
//  4. Per-file idempotency (HasFrontmatter short-circuit)
//  5. Title used for H1 fallback (filename minus .md)
//  6. Subdirectories are descended
//  7. Non-.md files are skipped
//  8. Dotfiles + .trash/ are skipped
//  9. Logging: per-injection + completion summary entries

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/migrations"
)

// openMigrationDB opens a temporary sqlite.Pair and applies the embedded
// migrations (001_initial.sql + 002_tags_backlinks.sql) so the
// schema_migrations table exists. Returns the Writer *sql.DB.
func openMigrationDB(t *testing.T) *sql.DB {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "app.db")

	pair, err := sqlite.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("sqlite.Open: %v", err)
	}
	t.Cleanup(func() { _ = pair.Close() })

	sql001, err := migrations.FS.ReadFile("001_initial.sql")
	if err != nil {
		t.Fatalf("read 001_initial.sql: %v", err)
	}
	if _, err := pair.Writer.ExecContext(context.Background(), string(sql001)); err != nil {
		t.Fatalf("apply 001_initial: %v", err)
	}
	return pair.Writer
}

// newLogBuffer returns a slog.Logger that writes to a bytes.Buffer and
// a pointer to that buffer for assertion.
func newLogBuffer(t *testing.T) (*slog.Logger, *bytes.Buffer) {
	t.Helper()
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	return logger, &buf
}

// hasMarker checks whether the FrontmatterScaffoldMarker row exists in
// schema_migrations.
func hasMarker(t *testing.T, db *sql.DB) bool {
	t.Helper()
	var dummy string
	err := db.QueryRowContext(context.Background(),
		`SELECT version FROM schema_migrations WHERE version = ?`, FrontmatterScaffoldMarker,
	).Scan(&dummy)
	return err == nil
}

// mkNotesDir creates a temporary vault root + notes/ subdir and returns
// (dataDir, notesDir).
func mkNotesDir(t *testing.T) (string, string) {
	t.Helper()
	dataDir := t.TempDir()
	notesDir := filepath.Join(dataDir, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes: %v", err)
	}
	return dataDir, notesDir
}

// writeFile writes content at notesDir/rel, creating parent dirs as needed.
func writeFile(t *testing.T, base, rel string, content []byte) string {
	t.Helper()
	full := filepath.Join(base, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(full), err)
	}
	if err := os.WriteFile(full, content, 0o644); err != nil {
		t.Fatalf("writeFile %s: %v", rel, err)
	}
	return full
}

// readFile reads a file and returns its content.
func readFilePath(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("readFile %s: %v", path, err)
	}
	return b
}

// ---------------------------------------------------------------------------
// Test 1: Fresh vault with mixed files
// ---------------------------------------------------------------------------

func TestInjectFrontmatterScaffoldMigration_FreshVaultMixed(t *testing.T) {
	t.Parallel()
	db := openMigrationDB(t)
	_, notesDir := mkNotesDir(t)
	logger, _ := newLogBuffer(t)

	hasFM := []byte("---\ntags: []\n---\n\nHas frontmatter already.\n")
	noFM1 := []byte("# Alpha\n\nBody one.\n")
	noFM2 := []byte("# Beta\n\nBody two.\n")

	pathHasFM := writeFile(t, notesDir, "has-fm.md", hasFM)
	pathNoFM1 := writeFile(t, notesDir, "alpha.md", noFM1)
	pathNoFM2 := writeFile(t, notesDir, "beta.md", noFM2)

	if err := InjectFrontmatterScaffoldMigration(context.Background(), db, notesDir, logger); err != nil {
		t.Fatalf("migration: %v", err)
	}

	// has-fm.md must be byte-identical to the original.
	if got := readFilePath(t, pathHasFM); !bytes.Equal(got, hasFM) {
		t.Errorf("has-fm.md was modified:\ngot  %q\nwant %q", got, hasFM)
	}

	// alpha.md and beta.md must now start with the frontmatter scaffold.
	for _, p := range []string{pathNoFM1, pathNoFM2} {
		got := readFilePath(t, p)
		if !bytes.HasPrefix(got, []byte("---\ntags: []\n---\n\n")) {
			t.Errorf("%s: expected frontmatter prefix, got: %q", p, got)
		}
	}

	// Marker must be set.
	if !hasMarker(t, db) {
		t.Error("marker row not inserted after migration")
	}
}

// ---------------------------------------------------------------------------
// Test 2: Already-migrated vault — second run is a no-op
// ---------------------------------------------------------------------------

func TestInjectFrontmatterScaffoldMigration_Idempotent(t *testing.T) {
	t.Parallel()
	db := openMigrationDB(t)
	_, notesDir := mkNotesDir(t)
	logger, buf := newLogBuffer(t)

	noFM := []byte("# Note\n\nBody.\n")
	path := writeFile(t, notesDir, "note.md", noFM)

	// First run: should inject.
	if err := InjectFrontmatterScaffoldMigration(context.Background(), db, notesDir, logger); err != nil {
		t.Fatalf("first run: %v", err)
	}
	afterFirst := readFilePath(t, path)
	buf.Reset()

	// Second run: marker present → no-op.
	if err := InjectFrontmatterScaffoldMigration(context.Background(), db, notesDir, logger); err != nil {
		t.Fatalf("second run: %v", err)
	}
	afterSecond := readFilePath(t, path)

	if !bytes.Equal(afterFirst, afterSecond) {
		t.Errorf("second run mutated file:\ngot  %q\nwant %q", afterSecond, afterFirst)
	}
	// The second run must log the "already complete; skipping" message.
	if !strings.Contains(buf.String(), "already complete") {
		t.Errorf("expected 'already complete' log entry; log: %s", buf.String())
	}
}

// ---------------------------------------------------------------------------
// Test 3: Partial run resume (D-39)
// ---------------------------------------------------------------------------
//
// Strategy: inject an atomicWriteHook variable into InjectFrontmatterScaffoldMigration
// so tests can simulate a mid-walk AtomicWrite failure. See frontmatter_migration.go.

// setAtomicWriteHook replaces the test-time hook for AtomicWrite and returns
// a cleanup function that restores the nil hook.
// atomicWriteHook and atomicWriteHookMu are declared in frontmatter_migration.go.
func setAtomicWriteHook(t *testing.T, fn func(path string, data []byte) error) {
	t.Helper()
	atomicWriteHookMu.Lock()
	atomicWriteHook = fn
	atomicWriteHookMu.Unlock()
	t.Cleanup(func() {
		atomicWriteHookMu.Lock()
		atomicWriteHook = nil
		atomicWriteHookMu.Unlock()
	})
}

func TestInjectFrontmatterScaffoldMigration_PartialRunResume(t *testing.T) {
	// NOT parallel — uses a shared hook variable; running tests in sequence
	// prevents races. The hook is mutex-guarded to be safe with t.Parallel()
	// in other tests, but this test explicitly does not call t.Parallel().
	db := openMigrationDB(t)
	_, notesDir := mkNotesDir(t)
	logger, _ := newLogBuffer(t)

	// 5 files without frontmatter, named so they walk alphabetically.
	files := []string{"a.md", "b.md", "c.md", "d.md", "e.md"}
	for _, f := range files {
		writeFile(t, notesDir, f, []byte("# "+strings.TrimSuffix(f, ".md")+"\n\nBody.\n"))
	}

	// First run: fail after the 3rd AtomicWrite call.
	callCount := 0
	setAtomicWriteHook(t, func(_ string, _ []byte) error {
		callCount++
		if callCount == 3 {
			return fmt.Errorf("simulated disk error")
		}
		return nil
	})

	err := InjectFrontmatterScaffoldMigration(context.Background(), db, notesDir, logger)
	if err == nil {
		t.Fatal("expected error from partial run; got nil")
	}

	// Marker must NOT be set after a failed run.
	if hasMarker(t, db) {
		t.Error("marker was set despite partial run failure")
	}

	// Clear hook for the second run.
	setAtomicWriteHook(t, nil)

	// Second run: should complete and set marker.
	if err := InjectFrontmatterScaffoldMigration(context.Background(), db, notesDir, logger); err != nil {
		t.Fatalf("second run after resume: %v", err)
	}
	if !hasMarker(t, db) {
		t.Error("marker not set after successful resume run")
	}

	// All files must have frontmatter now.
	for _, f := range files {
		got := readFilePath(t, filepath.Join(notesDir, f))
		if !bytes.HasPrefix(got, []byte("---\ntags: []\n---\n\n")) {
			t.Errorf("%s: expected frontmatter prefix after resume, got: %q", f, got)
		}
	}
}

// ---------------------------------------------------------------------------
// Test 4: Per-file idempotency — file with frontmatter is unchanged
// ---------------------------------------------------------------------------

func TestInjectFrontmatterScaffoldMigration_PerFileIdempotent(t *testing.T) {
	t.Parallel()
	db := openMigrationDB(t)
	_, notesDir := mkNotesDir(t)
	logger, _ := newLogBuffer(t)

	hasFM := []byte("---\ntags: [go, tdd]\n---\n\n# My Note\n\nBody here.\n")
	path := writeFile(t, notesDir, "already.md", hasFM)

	if err := InjectFrontmatterScaffoldMigration(context.Background(), db, notesDir, logger); err != nil {
		t.Fatalf("migration: %v", err)
	}

	got := readFilePath(t, path)
	if !bytes.Equal(got, hasFM) {
		t.Errorf("file with frontmatter was modified:\ngot  %q\nwant %q", got, hasFM)
	}
}

// ---------------------------------------------------------------------------
// Test 5: Title used for H1 fallback (filename minus .md)
// ---------------------------------------------------------------------------

func TestInjectFrontmatterScaffoldMigration_TitleFromFilename(t *testing.T) {
	t.Parallel()
	db := openMigrationDB(t)
	_, notesDir := mkNotesDir(t)
	logger, _ := newLogBuffer(t)

	// File has no frontmatter and no H1 — just plain body text.
	body := []byte("Some content without any heading.\n")
	path := writeFile(t, notesDir, "Hello-World.md", body)

	if err := InjectFrontmatterScaffoldMigration(context.Background(), db, notesDir, logger); err != nil {
		t.Fatalf("migration: %v", err)
	}

	got := string(readFilePath(t, path))
	wantPrefix := "---\ntags: []\n---\n\n# Hello-World\n\n"
	if !strings.HasPrefix(got, wantPrefix) {
		t.Errorf("file content:\ngot  %q\nwantPrefix %q", got, wantPrefix)
	}
	// Original body must still be present.
	if !strings.Contains(got, "Some content without any heading.") {
		t.Errorf("original body missing from migrated file: %q", got)
	}
}

// ---------------------------------------------------------------------------
// Test 6: Subdirectories are descended
// ---------------------------------------------------------------------------

func TestInjectFrontmatterScaffoldMigration_Subdirectories(t *testing.T) {
	t.Parallel()
	db := openMigrationDB(t)
	_, notesDir := mkNotesDir(t)
	logger, _ := newLogBuffer(t)

	path := writeFile(t, notesDir, "sub/folder/foo.md", []byte("# Foo\n"))

	if err := InjectFrontmatterScaffoldMigration(context.Background(), db, notesDir, logger); err != nil {
		t.Fatalf("migration: %v", err)
	}

	got := readFilePath(t, path)
	if !bytes.HasPrefix(got, []byte("---\ntags: []\n---\n\n")) {
		t.Errorf("nested file not migrated: %q", got)
	}
}

// ---------------------------------------------------------------------------
// Test 7: Non-.md files are skipped
// ---------------------------------------------------------------------------

func TestInjectFrontmatterScaffoldMigration_SkipsNonMarkdown(t *testing.T) {
	t.Parallel()
	db := openMigrationDB(t)
	_, notesDir := mkNotesDir(t)
	logger, _ := newLogBuffer(t)

	txtContent := []byte("plain text file\n")
	txtPath := writeFile(t, notesDir, "readme.txt", txtContent)
	// Also write a .md that should get migrated.
	mdPath := writeFile(t, notesDir, "note.md", []byte("# Note\n"))

	if err := InjectFrontmatterScaffoldMigration(context.Background(), db, notesDir, logger); err != nil {
		t.Fatalf("migration: %v", err)
	}

	// .txt must be byte-identical.
	if got := readFilePath(t, txtPath); !bytes.Equal(got, txtContent) {
		t.Errorf(".txt was modified: %q", got)
	}
	// .md must be migrated.
	if got := readFilePath(t, mdPath); !bytes.HasPrefix(got, []byte("---\ntags: []\n---\n\n")) {
		t.Errorf(".md not migrated: %q", got)
	}
}

// ---------------------------------------------------------------------------
// Test 8: Dotfiles and .trash/ are skipped
// ---------------------------------------------------------------------------

func TestInjectFrontmatterScaffoldMigration_SkipsDotfiles(t *testing.T) {
	t.Parallel()
	db := openMigrationDB(t)
	_, notesDir := mkNotesDir(t)
	logger, _ := newLogBuffer(t)

	dotContent := []byte("hidden file\n")
	dotFilePath := writeFile(t, notesDir, ".hidden.md", dotContent)
	trashContent := []byte("trashed note\n")
	trashPath := writeFile(t, notesDir, ".trash/old-note.md", trashContent)
	// Normal note.
	mdPath := writeFile(t, notesDir, "visible.md", []byte("# Visible\n"))

	if err := InjectFrontmatterScaffoldMigration(context.Background(), db, notesDir, logger); err != nil {
		t.Fatalf("migration: %v", err)
	}

	if got := readFilePath(t, dotFilePath); !bytes.Equal(got, dotContent) {
		t.Errorf(".hidden.md was modified: %q", got)
	}
	if got := readFilePath(t, trashPath); !bytes.Equal(got, trashContent) {
		t.Errorf(".trash/old-note.md was modified: %q", got)
	}
	if got := readFilePath(t, mdPath); !bytes.HasPrefix(got, []byte("---\ntags: []\n---\n\n")) {
		t.Errorf("visible.md not migrated: %q", got)
	}
}

// ---------------------------------------------------------------------------
// Test 9: Logging — per-injection entry + summary at completion
// ---------------------------------------------------------------------------

func TestInjectFrontmatterScaffoldMigration_Logging(t *testing.T) {
	t.Parallel()
	db := openMigrationDB(t)
	_, notesDir := mkNotesDir(t)
	logger, buf := newLogBuffer(t)

	// 2 files without frontmatter, 1 with.
	writeFile(t, notesDir, "a.md", []byte("# A\n"))
	writeFile(t, notesDir, "b.md", []byte("# B\n"))
	writeFile(t, notesDir, "c.md", []byte("---\ntags: []\n---\n\n# C\n"))

	if err := InjectFrontmatterScaffoldMigration(context.Background(), db, notesDir, logger); err != nil {
		t.Fatalf("migration: %v", err)
	}

	logOutput := buf.String()
	// At least 2 per-injection log entries.
	injectCount := strings.Count(logOutput, "injected")
	if injectCount < 2 {
		t.Errorf("expected at least 2 'injected' log entries, got %d; log:\n%s", injectCount, logOutput)
	}
	// Summary entry.
	if !strings.Contains(logOutput, "injected_count") {
		t.Errorf("expected 'injected_count' in completion log; log:\n%s", logOutput)
	}
	if !strings.Contains(logOutput, "skipped_count") {
		t.Errorf("expected 'skipped_count' in completion log; log:\n%s", logOutput)
	}
}
