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

func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

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

	var v string
	row := pair.Reader.QueryRowContext(context.Background(),
		`SELECT version FROM schema_migrations`)
	if err := row.Scan(&v); err != nil {
		t.Fatalf("schema_migrations row: %v", err)
	}
	if v != "001_initial.sql" {
		t.Errorf("version: got %q, want %q", v, "001_initial.sql")
	}

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

	ctx := context.Background()
	initialSQL, err := migrations.FS.ReadFile("001_initial.sql")
	if err != nil {
		t.Fatalf("read embedded: %v", err)
	}
	if _, err := pair.Writer.ExecContext(ctx, string(initialSQL)); err != nil {
		t.Fatalf("seed schema: %v", err)
	}
	if _, err := pair.Writer.ExecContext(
		ctx,
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

// TestRun_BrokenMigration_FiresPath1 is the canonical "Path 1 keeps the app on
// the prior schema" flow. The backup is taken BEFORE any migration in this Run,
// so the restored state is whatever the Run started with.
func TestRun_BrokenMigration_FiresPath1(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	pair := newTestPair(t, dir)

	initialSQL, err := migrations.FS.ReadFile("001_initial.sql")
	if err != nil {
		t.Fatalf("read embedded: %v", err)
	}

	ctx := context.Background()
	if _, err := pair.Writer.ExecContext(ctx, string(initialSQL)); err != nil {
		t.Fatalf("seed 001 schema: %v", err)
	}
	if _, err := pair.Writer.ExecContext(
		ctx,
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

	if _, err := os.Stat(filepath.Join(dir, "app.db.backup")); !os.IsNotExist(err) {
		t.Errorf("backup file should NOT exist after disk-full preflight; stat err=%v", err)
	}

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

	ctx := context.Background()
	initialSQL, err := migrations.FS.ReadFile("001_initial.sql")
	if err != nil {
		t.Fatalf("read embedded: %v", err)
	}
	if _, err := pair.Writer.ExecContext(ctx, string(initialSQL)); err != nil {
		t.Fatalf("seed schema: %v", err)
	}
	if _, err := pair.Writer.ExecContext(
		ctx,
		`INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)`,
		"001_initial.sql", int64(1),
	); err != nil {
		t.Fatalf("seed migrations: %v", err)
	}

	_ = pair.Close()

	dbPath := filepath.Join(dir, "app.db")
	mfs := fstest.MapFS{
		"001_initial.sql": &fstest.MapFile{Data: initialSQL},
		"002_break.sql":   &fstest.MapFile{Data: []byte("INVALID SQL;")},
	}

	pair2, err := sqlite.Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}
	t.Cleanup(func() { _ = pair2.Close() })

	backupPath := filepath.Join(dir, "app.db.backup")
	if err := BackupBeforeMigration(dbPath, backupPath); err != nil {
		t.Fatalf("seed backup: %v", err)
	}

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

	if _, err := pair.Writer.ExecContext(
		context.Background(),
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

// TestRebuildAndReindex_NoPath2Rebuild_FiresPath3 — Path2Rebuild is
// nil (composition root forgot to wire it). The drop + re-apply
// migrations succeeds, but the rebuild step has no callable, so we
// fall through to Path 3.
func TestRebuildAndReindex_NoPath2Rebuild_FiresPath3(t *testing.T) {
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

	if _, err := r.Run(context.Background()); err != nil {
		t.Fatalf("seed Run: %v", err)
	}

	st, err := r.RebuildAndReindex(context.Background())
	if err == nil {
		t.Fatalf("RebuildAndReindex: got nil err, want ErrUnrecoverable (no Path2Rebuild)")
	}
	if !errors.Is(err, ErrUnrecoverable) {
		t.Fatalf("err: got %v, want errors.Is(err, ErrUnrecoverable)", err)
	}
	if st.State != StateUnrecoverable {
		t.Errorf("State: got %q, want %q", st.State, StateUnrecoverable)
	}
}

// TestRebuildAndReindex_HappyPath — Path2Rebuild returns (5, nil);
// rebuild drops the table, re-applies migrations, calls Path2Rebuild,
// and reports State=OK with NotesIndexed=5.
func TestRebuildAndReindex_HappyPath(t *testing.T) {
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

	if _, err := r.Run(context.Background()); err != nil {
		t.Fatalf("seed Run: %v", err)
	}
	rebuildCalls := 0
	r.Path2Rebuild = func(_ context.Context) (int, error) {
		rebuildCalls++
		return 5, nil
	}
	st, err := r.RebuildAndReindex(context.Background())
	if err != nil {
		t.Fatalf("RebuildAndReindex: %v", err)
	}
	if st.State != StateOK {
		t.Errorf("State: got %q, want %q", st.State, StateOK)
	}
	if st.NotesIndexed != 5 {
		t.Errorf("NotesIndexed: got %d, want 5", st.NotesIndexed)
	}
	if rebuildCalls != 1 {
		t.Errorf("Path2Rebuild calls: got %d, want 1", rebuildCalls)
	}

	var n int
	if err := pair.Reader.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM schema_migrations`).Scan(&n); err != nil {
		t.Fatalf("count schema_migrations: %v", err)
	}
	if n != 1 {
		t.Errorf("schema_migrations rows: got %d, want 1", n)
	}
}

// TestRebuildAndReindex_RebuildFails_FiresPath3 — Path2Rebuild returns
// an error; rebuild surfaces ErrUnrecoverable + StateUnrecoverable.
func TestRebuildAndReindex_RebuildFails_FiresPath3(t *testing.T) {
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
	if _, err := r.Run(context.Background()); err != nil {
		t.Fatalf("seed Run: %v", err)
	}
	r.Path2Rebuild = func(_ context.Context) (int, error) {
		return 0, errors.New("rebuild boom")
	}
	st, err := r.RebuildAndReindex(context.Background())
	if err == nil {
		t.Fatalf("RebuildAndReindex: got nil err, want ErrUnrecoverable")
	}
	if !errors.Is(err, ErrUnrecoverable) {
		t.Fatalf("err: got %v, want errors.Is(err, ErrUnrecoverable)", err)
	}
	if st.State != StateUnrecoverable {
		t.Errorf("State: got %q, want %q", st.State, StateUnrecoverable)
	}
}
