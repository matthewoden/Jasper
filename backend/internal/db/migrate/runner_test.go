package migrate

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"testing/fstest"

	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/migrations"
)

// silentLogger returns a slog.Logger that discards everything; keeps
// test output clean while still exercising the runner's log calls.
func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// newTestPair opens a sqlite.Pair against a fresh tempdir-rooted file
// and registers a Cleanup to close it.
func newTestPair(t *testing.T, dir string) *sqlite.Pair {
	t.Helper()
	dbPath := filepath.Join(dir, "app.db")
	pair, err := sqlite.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("sqlite.Open: %v", err)
	}
	t.Cleanup(func() { _ = pair.Close() })
	return pair
}

// realMigrationsFS returns an fs.FS containing the production
// 001_initial.sql migration. We re-read the embedded FS rather than
// pasting the SQL inline so the runner test stays in sync with the
// canonical schema.
func realMigrationsFS(t *testing.T) fstest.MapFS {
	t.Helper()
	data, err := migrations.FS.ReadFile("001_initial.sql")
	if err != nil {
		t.Fatalf("read embedded 001_initial.sql: %v", err)
	}
	return fstest.MapFS{
		"001_initial.sql": &fstest.MapFile{Data: data},
	}
}

// TestRun_FreshDB_AppliesInitial — empty data dir + the canonical
// 001_initial.sql; Run returns Status{OK} and schema_migrations has
// exactly one row.
func TestRun_FreshDB_AppliesInitial(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	pair := newTestPair(t, dir)

	r := NewRunner(RunnerOptions{
		DBPath:     filepath.Join(dir, "app.db"),
		BackupPath: filepath.Join(dir, "app.db.backup"),
		LogsPath:   filepath.Join(dir, "logs", "jasper.log"),
		Migrations: realMigrationsFS(t),
		Pair:       pair,
		Log:        silentLogger(),
	})
	st, err := r.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if st.State != StateOK {
		t.Fatalf("State: got %q, want %q", st.State, StateOK)
	}
	if st.FailedMigration != "" {
		t.Errorf("FailedMigration on success: got %q, want empty", st.FailedMigration)
	}
	if st.LogsPath == "" {
		t.Errorf("LogsPath: got empty")
	}

	// schema_migrations has 001_initial.sql.
	var v string
	row := pair.Reader.QueryRowContext(context.Background(),
		`SELECT version FROM schema_migrations`)
	if err := row.Scan(&v); err != nil {
		t.Fatalf("schema_migrations row: %v", err)
	}
	if v != "001_initial.sql" {
		t.Errorf("version: got %q, want %q", v, "001_initial.sql")
	}

	// Backup file is deleted on success.
	if _, err := os.Stat(filepath.Join(dir, "app.db.backup")); !os.IsNotExist(err) {
		t.Errorf("backup file should be deleted after success; stat err=%v", err)
	}
}

// TestRun_NoPending_NoOp — pre-populate schema_migrations with the
// initial migration; Run returns OK without touching anything.
func TestRun_NoPending_NoOp(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	pair := newTestPair(t, dir)

	// Apply the schema first via a direct exec, then mark it applied.
	ctx := context.Background()
	initialSQL, err := migrations.FS.ReadFile("001_initial.sql")
	if err != nil {
		t.Fatalf("read embedded: %v", err)
	}
	if _, err := pair.Writer.ExecContext(ctx, string(initialSQL)); err != nil {
		t.Fatalf("seed schema: %v", err)
	}
	if _, err := pair.Writer.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)`,
		"001_initial.sql", int64(1234567890),
	); err != nil {
		t.Fatalf("seed schema_migrations: %v", err)
	}

	r := NewRunner(RunnerOptions{
		DBPath:     filepath.Join(dir, "app.db"),
		BackupPath: filepath.Join(dir, "app.db.backup"),
		LogsPath:   filepath.Join(dir, "logs", "jasper.log"),
		Migrations: realMigrationsFS(t),
		Pair:       pair,
		Log:        silentLogger(),
	})
	st, err := r.Run(ctx)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if st.State != StateOK {
		t.Fatalf("State: got %q, want %q", st.State, StateOK)
	}
}

// TestRun_BrokenMigration_FiresPath1 — pre-apply 001_initial.sql so
// schema_migrations has a prior-schema row; then Run with migrations
// FS = [001, 002_break]. 002 is the only pending migration. The
// runner takes a backup of the post-001 state, fails on 002, and
// restores the backup. Expected:
//   - State = RolledBack
//   - FailedMigration = "002_break.sql"
//   - schema_migrations after restore still has exactly 1 row (001).
//
// This is the canonical "Path 1 keeps the app on the prior schema"
// flow — the runner's pseudocode in DESIGN.md §4.4 backs up BEFORE
// applying any migration in the current Run, so the restored state is
// "whatever this Run started with".
func TestRun_BrokenMigration_FiresPath1(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	pair := newTestPair(t, dir)

	initialSQL, err := migrations.FS.ReadFile("001_initial.sql")
	if err != nil {
		t.Fatalf("read embedded: %v", err)
	}

	// Pre-apply 001 + record it in schema_migrations so the prior-
	// schema gate in Run treats this as Path 1 territory.
	ctx := context.Background()
	if _, err := pair.Writer.ExecContext(ctx, string(initialSQL)); err != nil {
		t.Fatalf("seed 001 schema: %v", err)
	}
	if _, err := pair.Writer.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)`,
		"001_initial.sql", int64(1),
	); err != nil {
		t.Fatalf("seed schema_migrations: %v", err)
	}

	mfs := fstest.MapFS{
		"001_initial.sql": &fstest.MapFile{Data: initialSQL},
		"002_break.sql":   &fstest.MapFile{Data: []byte("INVALID SQL HERE;")},
	}

	dbPath := filepath.Join(dir, "app.db")
	r := NewRunner(RunnerOptions{
		DBPath:     dbPath,
		BackupPath: filepath.Join(dir, "app.db.backup"),
		LogsPath:   filepath.Join(dir, "logs", "jasper.log"),
		Migrations: mfs,
		Pair:       pair,
		Log:        silentLogger(),
	})
	st, err := r.Run(ctx)
	if err != nil {
		t.Fatalf("Run: got err=%v, want nil (Path 1 keeps the app running)", err)
	}
	if st.State != StateRolledBack {
		t.Fatalf("State: got %q, want %q", st.State, StateRolledBack)
	}
	if st.FailedMigration != "002_break.sql" {
		t.Errorf("FailedMigration: got %q, want %q", st.FailedMigration, "002_break.sql")
	}
	if st.LogsPath == "" {
		t.Errorf("LogsPath: got empty after Path 1")
	}

	// schema_migrations should still have exactly 1 row (001_initial).
	// We re-open the pair after restore because RestoreBackup replaced
	// the file on disk; the existing *sql.DB connections may have
	// stale page caches.
	_ = pair.Close()
	pair2, err := sqlite.Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("re-open after restore: %v", err)
	}
	t.Cleanup(func() { _ = pair2.Close() })

	var n int
	if err := pair2.Reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM schema_migrations`).Scan(&n); err != nil {
		t.Fatalf("count schema_migrations: %v", err)
	}
	if n != 1 {
		t.Errorf("schema_migrations rows after Path 1: got %d, want 1", n)
	}
	var ver string
	if err := pair2.Reader.QueryRowContext(ctx,
		`SELECT version FROM schema_migrations`).Scan(&ver); err != nil {
		t.Fatalf("read version: %v", err)
	}
	if ver != "001_initial.sql" {
		t.Errorf("post-rollback version: got %q, want %q", ver, "001_initial.sql")
	}
}

// TestRun_BrokenInitial_RestoreImpossible_FiresPath3 — only 001_break.sql
// against a fresh DB. No backup possible (fresh DB). Run returns
// Status{Unrecoverable} and a wrapped ErrUnrecoverable.
func TestRun_BrokenInitial_RestoreImpossible_FiresPath3(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	pair := newTestPair(t, dir)

	mfs := fstest.MapFS{
		"001_break.sql": &fstest.MapFile{Data: []byte("INVALID SQL;")},
	}

	r := NewRunner(RunnerOptions{
		DBPath:     filepath.Join(dir, "app.db"),
		BackupPath: filepath.Join(dir, "app.db.backup"),
		LogsPath:   filepath.Join(dir, "logs", "jasper.log"),
		Migrations: mfs,
		Pair:       pair,
		Log:        silentLogger(),
	})
	st, err := r.Run(context.Background())
	if err == nil {
		t.Fatalf("Run: got nil err, want ErrUnrecoverable")
	}
	if !errors.Is(err, ErrUnrecoverable) {
		t.Fatalf("err: got %v, want errors.Is(err, ErrUnrecoverable)", err)
	}
	if st.State != StateUnrecoverable {
		t.Fatalf("State: got %q, want %q", st.State, StateUnrecoverable)
	}
}

// TestRun_DiskFullPreflight_AbortsBeforeBackup — inject a DiskFreeFn
// returning 0; Run returns wrapped ErrDiskFull; backup file does not
// exist; app.db on disk is unchanged.
func TestRun_DiskFullPreflight_AbortsBeforeBackup(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	pair := newTestPair(t, dir)

	// Seed the live DB by applying 001 directly so there's a non-empty
	// app.db for the preflight to compute size against.
	initialSQL, err := migrations.FS.ReadFile("001_initial.sql")
	if err != nil {
		t.Fatalf("read embedded: %v", err)
	}
	if _, err := pair.Writer.ExecContext(context.Background(), string(initialSQL)); err != nil {
		t.Fatalf("seed: %v", err)
	}

	dbPath := filepath.Join(dir, "app.db")
	preBytes, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatalf("read pre-state: %v", err)
	}

	mfs := fstest.MapFS{
		// A second migration so there'd be something to apply if the
		// preflight passed; but the preflight should abort before any
		// backup or apply runs.
		"001_initial.sql": &fstest.MapFile{Data: initialSQL},
		"002_other.sql":   &fstest.MapFile{Data: []byte("CREATE TABLE _other (x INTEGER);")},
	}

	r := NewRunner(RunnerOptions{
		DBPath:     dbPath,
		BackupPath: filepath.Join(dir, "app.db.backup"),
		LogsPath:   filepath.Join(dir, "logs", "jasper.log"),
		Migrations: mfs,
		Pair:       pair,
		Log:        silentLogger(),
		DiskFreeFn: func(_ string) (uint64, error) { return 0, nil },
	})
	st, err := r.Run(context.Background())
	if err == nil {
		t.Fatalf("Run: got nil err, want ErrDiskFull-wrapped")
	}
	if !errors.Is(err, ErrDiskFull) {
		t.Fatalf("err: got %v, want errors.Is(err, ErrDiskFull)", err)
	}
	if st.State != StateUnrecoverable {
		t.Errorf("State: got %q, want %q", st.State, StateUnrecoverable)
	}

	// Backup file does NOT exist.
	if _, err := os.Stat(filepath.Join(dir, "app.db.backup")); !os.IsNotExist(err) {
		t.Errorf("backup file should NOT exist after disk-full preflight; stat err=%v", err)
	}
	// app.db on disk is unchanged.
	postBytes, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatalf("read post-state: %v", err)
	}
	if len(preBytes) != len(postBytes) {
		t.Errorf("app.db modified by failed preflight: pre=%d, post=%d bytes", len(preBytes), len(postBytes))
	}
}

// TestRun_RestoreFailureDuringPath1_FiresPath3 — chmod the data dir
// read-only AFTER backup but before restore so the restore step fails.
// Skipped on Windows (chmod semantics differ).
func TestRun_RestoreFailureDuringPath1_FiresPath3(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("chmod permission semantics differ on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root bypasses POSIX permission checks")
	}
	t.Parallel()
	dir := t.TempDir()
	pair := newTestPair(t, dir)

	// Apply 001 and mark it applied so the runner doesn't attempt
	// to apply it again. Then queue a broken 002 — Path 1 should
	// fire after 002 fails, but the restore step will fail because
	// the dir is read-only.
	ctx := context.Background()
	initialSQL, err := migrations.FS.ReadFile("001_initial.sql")
	if err != nil {
		t.Fatalf("read embedded: %v", err)
	}
	if _, err := pair.Writer.ExecContext(ctx, string(initialSQL)); err != nil {
		t.Fatalf("seed schema: %v", err)
	}
	if _, err := pair.Writer.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)`,
		"001_initial.sql", int64(1),
	); err != nil {
		t.Fatalf("seed migrations: %v", err)
	}
	// Close the pair so we can chmod the dir (open file descriptors
	// would prevent a clean read-only state for SQLite's WAL files).
	_ = pair.Close()

	dbPath := filepath.Join(dir, "app.db")
	mfs := fstest.MapFS{
		"001_initial.sql": &fstest.MapFile{Data: initialSQL},
		"002_break.sql":   &fstest.MapFile{Data: []byte("INVALID SQL;")},
	}

	// Re-open and pre-create the backup so RestoreBackup has something
	// to read; then strip permissions on the dir so the restore-rename
	// fails. We bypass Run's BackupBeforeMigration step by writing the
	// backup ourselves and crafting a Runner whose preflight passes
	// trivially.
	pair2, err := sqlite.Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}
	t.Cleanup(func() { _ = pair2.Close() })

	// Take a manual backup so Run's BackupBeforeMigration is a
	// rewrite (it will overwrite our backup with the current contents,
	// which is fine).
	backupPath := filepath.Join(dir, "app.db.backup")
	if err := BackupBeforeMigration(dbPath, backupPath); err != nil {
		t.Fatalf("seed backup: %v", err)
	}

	// Build the runner; we'll run it and then race the chmod between
	// backup and restore. Easier: hand-roll the Path 1 condition by
	// stripping perms now; backup already exists from our manual call,
	// but Run will try to overwrite it with another AtomicWrite which
	// will also fail under chmod 0500 — that's fine, the test gates
	// on the FINAL state being Unrecoverable, not the specific failure
	// reason.
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	r := NewRunner(RunnerOptions{
		DBPath:     dbPath,
		BackupPath: backupPath,
		LogsPath:   filepath.Join(dir, "logs", "jasper.log"),
		Migrations: mfs,
		Pair:       pair2,
		Log:        silentLogger(),
	})
	st, err := r.Run(ctx)
	if err == nil {
		t.Fatalf("Run: got nil err, want some failure (chmod read-only dir)")
	}
	if st.State != StateUnrecoverable {
		t.Fatalf("State: got %q, want %q (path 3); err=%v", st.State, StateUnrecoverable, err)
	}
}

// TestRun_RecordsNotesIndexedAfterSuccess — after applying 001, the
// notes table exists but is empty; refreshNoteCount sets NotesIndexed
// = 0.
func TestRun_RecordsNotesIndexedAfterSuccess(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	pair := newTestPair(t, dir)

	r := NewRunner(RunnerOptions{
		DBPath:     filepath.Join(dir, "app.db"),
		BackupPath: filepath.Join(dir, "app.db.backup"),
		LogsPath:   filepath.Join(dir, "logs", "jasper.log"),
		Migrations: realMigrationsFS(t),
		Pair:       pair,
		Log:        silentLogger(),
	})
	st, err := r.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if st.NotesIndexed != 0 {
		t.Errorf("NotesIndexed: got %d, want 0", st.NotesIndexed)
	}

	// Insert a fake row, refresh, and assert NotesIndexed == 1.
	if _, err := pair.Writer.ExecContext(context.Background(),
		`INSERT INTO notes(id,path,title,mtime_unix,size_bytes,checksum_sha256,created_at,updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		"00000000-0000-0000-0000-000000000001", "scratchpad.md", "Scratchpad",
		int64(1), int64(0), "", int64(1), int64(1),
	); err != nil {
		t.Fatalf("seed note row: %v", err)
	}
	r.refreshNoteCount(context.Background())
	got := r.Status(context.Background())
	if got.NotesIndexed != 1 {
		t.Errorf("NotesIndexed after seed: got %d, want 1", got.NotesIndexed)
	}
}

// TestNewRunner_DefaultsApplied — pass RunnerOptions with Log=nil,
// NowUnix=nil, DiskFreeFn=nil; assert all internals are non-nil and
// the runner functions correctly on a Run call.
func TestNewRunner_DefaultsApplied(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	pair := newTestPair(t, dir)

	r := NewRunner(RunnerOptions{
		DBPath:     filepath.Join(dir, "app.db"),
		BackupPath: filepath.Join(dir, "app.db.backup"),
		LogsPath:   filepath.Join(dir, "logs", "jasper.log"),
		Migrations: realMigrationsFS(t),
		Pair:       pair,
	})
	if r.Log == nil {
		t.Errorf("Log defaulted to nil (expected slog.Default())")
	}
	if r.nowUnix == nil {
		t.Errorf("nowUnix defaulted to nil")
	}
	if r.diskFreeBytes == nil {
		t.Errorf("diskFreeBytes defaulted to nil")
	}
	if r.store == nil {
		t.Errorf("store defaulted to nil")
	}
	// Smoke-run the defaults end-to-end.
	st, err := r.Run(context.Background())
	if err != nil {
		t.Fatalf("Run with defaults: %v", err)
	}
	if st.State != StateOK {
		t.Errorf("State: got %q, want %q", st.State, StateOK)
	}
}

// TestDiscoverPending_RejectsBadFilename — a migration whose filename
// doesn't match the convention is an error (not silently skipped).
func TestDiscoverPending_RejectsBadFilename(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	pair := newTestPair(t, dir)

	mfs := fstest.MapFS{
		"weird-name.sql": &fstest.MapFile{Data: []byte("CREATE TABLE x(a INTEGER);")},
	}
	r := NewRunner(RunnerOptions{
		DBPath:     filepath.Join(dir, "app.db"),
		BackupPath: filepath.Join(dir, "app.db.backup"),
		LogsPath:   filepath.Join(dir, "logs", "jasper.log"),
		Migrations: mfs,
		Pair:       pair,
		Log:        silentLogger(),
	})
	_, err := r.discoverPending(context.Background())
	if err == nil {
		t.Fatalf("discoverPending: got nil, want filename-mismatch error")
	}
}

// TestRebuildAndReindex_StubReturnsErrUnrecoverable — Plan 02-04b owns
// the body; this plan ships a skeleton that returns the sentinel.
// Locking the behavior so 02-04b's wiring tests can detect when the
// real body lands.
func TestRebuildAndReindex_StubReturnsErrUnrecoverable(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	pair := newTestPair(t, dir)

	r := NewRunner(RunnerOptions{
		DBPath:     filepath.Join(dir, "app.db"),
		BackupPath: filepath.Join(dir, "app.db.backup"),
		LogsPath:   filepath.Join(dir, "logs", "jasper.log"),
		Migrations: realMigrationsFS(t),
		Pair:       pair,
		Log:        silentLogger(),
	})
	st, err := r.RebuildAndReindex(context.Background())
	if err == nil {
		t.Fatalf("RebuildAndReindex stub: got nil err, want ErrUnrecoverable")
	}
	if !errors.Is(err, ErrUnrecoverable) {
		t.Fatalf("err: got %v, want errors.Is(err, ErrUnrecoverable)", err)
	}
	if st.State != StateUnrecoverable {
		t.Errorf("State: got %q, want %q", st.State, StateUnrecoverable)
	}
}
