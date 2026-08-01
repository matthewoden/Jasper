package migrate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"regexp"
	"sort"
	"time"

	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
)

// ErrUnrecoverable is returned by Run when Path 3 fires. The composition
// root must refuse to start the HTTP listener and serve the static error
// page instead. Callers detect with errors.Is.
var ErrUnrecoverable = errors.New("migrate: unrecoverable schema state — manual intervention required")

var migrationFilenamePattern = regexp.MustCompile(`^[0-9]{3}_[a-z0-9_]+\.sql$`)

// RunnerOptions is the constructor input for NewRunner. All fields are
// required EXCEPT NowUnix / DiskFreeFn / Log which default to production
// implementations when nil.
type RunnerOptions struct {
	DBPath     string       // <dataDir>/.jasper/app.db (absolute)
	BackupPath string       // <dataDir>/.jasper/app.db.backup (absolute)
	LogsPath   string       // <dataDir>/.jasper/logs/jasper.log (surfaced via MigrationStatus.LogsPath)
	Migrations fs.FS        // migrations.FS from backend/migrations
	Pair       *sqlite.Pair // writer/reader pair from internal/db/sqlite
	Log        *slog.Logger
	NowUnix    func() int64                      // injectable clock for tests; defaults to time.Now().Unix
	DiskFreeFn func(path string) (uint64, error) // injectable for tests; production default reads syscall.Statfs
}

// Runner is the three-path migration orchestrator.
//
// Lifecycle of a single Run(ctx) call:
//
//  1. PreflightFreeSpace — abort with ErrDiskFull if free < 2× current
//     app.db size.
//  2. Discover pending migrations from Migrations FS (lex-sorted; only
//     those NOT in schema_migrations are pending).
//  3. If none pending, refresh notes_indexed, set Status = OK, return.
//  4. BackupBeforeMigration -> backupPath (no-op on a fresh DB).
//  5. For each pending migration in order:
//     BEGIN IMMEDIATE; tx.Exec(<sql>); INSERT INTO schema_migrations; COMMIT.
//     On any failure inside the transaction: rollback + Path 1.
//     6a. All succeed → DeleteBackup; Status = OK; return.
//     6b. Any failed → Path 1 — RestoreBackup; Status = RolledBack; Run
//     returns nil error (the app keeps running on the prior schema).
//  7. Path 2 (RebuildAndReindex) is triggered by POST /admin/reindex.
//     Path 3 (Unrecoverable) fires when restore itself fails OR when
//     Path 2 also fails.
type Runner struct {
	DBPath       string
	BackupPath   string
	LogsPath     string
	Migrations   fs.FS
	Pair         *sqlite.Pair
	Log          *slog.Logger
	Path2Rebuild func(context.Context) (notesIndexed int, err error)

	store         *statusStore
	nowUnix       func() int64
	diskFreeBytes func(string) (uint64, error)
}

// NewRunner constructs a Runner from opts. Required fields:
//
//	DBPath, BackupPath, LogsPath, Migrations, Pair
//
// Optional fields (NowUnix, DiskFreeFn, Log) get sane production
// defaults when nil. DiskFreeFn defaults to the package-level freeBytes
// function (which honors the JASPER_TEST_FORCE_DISK_FULL hook).
func NewRunner(opts RunnerOptions) *Runner {
	if opts.NowUnix == nil {
		opts.NowUnix = func() int64 { return time.Now().Unix() }
	}
	if opts.DiskFreeFn == nil {
		opts.DiskFreeFn = freeBytes
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	return &Runner{
		DBPath:        opts.DBPath,
		BackupPath:    opts.BackupPath,
		LogsPath:      opts.LogsPath,
		Migrations:    opts.Migrations,
		Pair:          opts.Pair,
		Log:           opts.Log,
		store:         &statusStore{},
		nowUnix:       opts.NowUnix,
		diskFreeBytes: opts.DiskFreeFn,
	}
}

// Status implements StatusProvider so api.Server can read live status
// directly from the Runner without a wrapper.
func (r *Runner) Status(ctx context.Context) Status {
	return r.store.Status(ctx)
}

// Run orchestrates the three-path migration strategy. See the Runner
// type doc for the full lifecycle. Returns:
//
//   - (Status{State: ok}, nil) when all migrations applied (or none
//     were pending).
//   - (Status{State: rolled_back, FailedMigration: <name>}, nil) when
//     Path 1 fired — the caller treats this as a successful start
//     (the app runs on the prior schema; the UX-03 banner is shown).
//   - (Status{State: unrecoverable}, ErrUnrecoverable) when Path 3
//     fires. The composition root refuses to start the HTTP listener.
//   - (Status{State: unrecoverable}, ErrDiskFull-wrapped) when the
//     pre-flight aborts. The composition root serves the static
//     disk-full.html page.
func (r *Runner) Run(ctx context.Context) (Status, error) {
	if err := r.preflight(); err != nil {
		r.Log.Error("migrate preflight failed", "err", err)
		out := Status{State: StateUnrecoverable, LogsPath: r.LogsPath}
		r.store.set(out)
		return out, err
	}

	applied, err := r.appliedMigrations(ctx)
	if err != nil {
		out := Status{State: StateUnrecoverable, LogsPath: r.LogsPath}
		r.store.set(out)
		return out, fmt.Errorf("read schema_migrations: %w", err)
	}
	hadPriorSchema := len(applied) > 0
	pending, err := r.pendingFromApplied(ctx, applied)
	if err != nil {
		out := Status{State: StateUnrecoverable, LogsPath: r.LogsPath}
		r.store.set(out)
		return out, fmt.Errorf("discover pending: %w", err)
	}
	if len(pending) == 0 {
		r.store.set(Status{State: StateOK, LogsPath: r.LogsPath})
		r.refreshNoteCount(ctx)
		return r.store.Status(ctx), nil
	}

	if err := BackupBeforeMigration(r.DBPath, r.BackupPath); err != nil {
		r.Log.Error("migrate backup failed", "err", err)
		out := Status{State: StateUnrecoverable, LogsPath: r.LogsPath}
		r.store.set(out)
		return out, fmt.Errorf("backup: %w", err)
	}

	if failed := r.applyAll(ctx, pending); failed != "" {
		if !hadPriorSchema {
			r.Log.Error(
				"Path 1 unavailable: no prior-applied schema to roll back to",
				"failed_migration", failed,
				"logs_path", r.LogsPath,
			)
			out := Status{
				State:           StateUnrecoverable,
				FailedMigration: failed,
				LogsPath:        r.LogsPath,
			}
			r.store.set(out)
			return out, fmt.Errorf("%w: %s failed and no prior schema applied", ErrUnrecoverable, failed)
		}
		backupExists := backupFileExists(r.BackupPath)
		if !backupExists {
			r.Log.Error(
				"Path 1 unavailable: no backup to restore (fresh DB or initial migration failed)",
				"failed_migration", failed,
				"logs_path", r.LogsPath,
			)
			out := Status{
				State:           StateUnrecoverable,
				FailedMigration: failed,
				LogsPath:        r.LogsPath,
			}
			r.store.set(out)
			return out, fmt.Errorf("%w: %s failed and no backup available", ErrUnrecoverable, failed)
		}
		if err := RestoreBackup(r.BackupPath, r.DBPath); err != nil {
			r.Log.Error(
				"Path 1 restore failed; entering unrecoverable",
				"failed_migration", failed,
				"restore_err", err,
				"logs_path", r.LogsPath,
			)
			out := Status{
				State:           StateUnrecoverable,
				FailedMigration: failed,
				LogsPath:        r.LogsPath,
			}
			r.store.set(out)
			return out, fmt.Errorf("%w: restore failed: %v (failed migration: %s)", ErrUnrecoverable, err, failed)
		}
		r.Log.Warn(
			"Path 1 fired: backup restored on prior schema",
			"failed_migration", failed,
			"logs_path", r.LogsPath,
		)
		r.store.set(Status{
			State:           StateRolledBack,
			FailedMigration: failed,
			LogsPath:        r.LogsPath,
		})
		r.refreshNoteCount(ctx)
		return r.store.Status(ctx), nil
	}

	if err := DeleteBackup(r.BackupPath); err != nil {
		r.Log.Warn("post-success backup delete failed (non-fatal)", "err", err)
	}
	r.store.set(Status{State: StateOK, LogsPath: r.LogsPath})
	r.refreshNoteCount(ctx)
	return r.store.Status(ctx), nil
}

func (r *Runner) preflight() error {
	info, err := osStatPath(r.DBPath)
	if err != nil {
		if isNotExistErr(err) {
			return nil
		}
		return fmt.Errorf("preflight stat %q: %w", r.DBPath, err)
	}
	currentSize := uint64(info.Size())
	free, err := r.diskFreeBytes(r.DBPath)
	if err != nil {
		return fmt.Errorf("preflight statfs %q: %w", r.DBPath, err)
	}
	required := 2 * currentSize
	if free < required {
		return fmt.Errorf(
			"%w: need %d bytes free, have %d (db size %d, required 2x = %d)",
			ErrDiskFull, required, free, currentSize, required,
		)
	}
	return nil
}

// Queryer is the read-only subset of *sql.DB the migration-state helpers need.
// Exists so diagnostics (jasper doctor) can ask the same questions the runner
// asks, over their own read-only connection, without constructing a Runner.
type Queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// PendingMigrations reports which embedded migrations are not yet recorded in
// schema_migrations, applying the same discovery and the same filename
// validation the runner applies before it will run anything.
//
// Sharing this matters more than the deduplication: a diagnostic that
// enumerates migrations by its own looser rule will call a file "pending" that
// the runner would refuse outright, and tell the user to restart a server that
// then declines to boot.
//
// Read-only — safe to call against a `?mode=ro` connection.
func PendingMigrations(ctx context.Context, reader Queryer, fsys fs.FS) ([]string, error) {
	applied, err := AppliedMigrations(ctx, reader)
	if err != nil {
		return nil, err
	}
	return pendingFromApplied(applied, fsys)
}

// AppliedMigrations returns the set of versions recorded in schema_migrations.
// An absent table is not an error — it means nothing has been applied yet.
func AppliedMigrations(ctx context.Context, reader Queryer) (map[string]struct{}, error) {
	out := make(map[string]struct{})

	var tableName string
	row := reader.QueryRowContext(ctx,
		`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
	if err := row.Scan(&tableName); err != nil {
		if errors.Is(err, sqlNoRows()) {
			return out, nil
		}
		return nil, fmt.Errorf("check schema_migrations table: %w", err)
	}

	rows, err := reader.QueryContext(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("query schema_migrations: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("scan version: %w", err)
		}
		out[v] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows.Err: %w", err)
	}
	return out, nil
}

func (r *Runner) discoverPending(ctx context.Context) ([]string, error) {
	applied, err := r.appliedMigrations(ctx)
	if err != nil {
		return nil, err
	}
	return r.pendingFromApplied(ctx, applied)
}

func (r *Runner) pendingFromApplied(_ context.Context, applied map[string]struct{}) ([]string, error) {
	return pendingFromApplied(applied, r.Migrations)
}

func pendingFromApplied(applied map[string]struct{}, fsys fs.FS) ([]string, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("read migrations FS: %w", err)
	}
	all := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !migrationFilenamePattern.MatchString(name) {
			return nil, fmt.Errorf("migration filename %q does not match %q", name, migrationFilenamePattern.String())
		}
		all = append(all, name)
	}
	sort.Strings(all)

	pending := make([]string, 0, len(all))
	for _, name := range all {
		if _, ok := applied[name]; ok {
			continue
		}
		pending = append(pending, name)
	}
	return pending, nil
}

func (r *Runner) appliedMigrations(ctx context.Context) (map[string]struct{}, error) {
	return AppliedMigrations(ctx, r.Pair.Reader)
}

func (r *Runner) applyAll(ctx context.Context, pending []string) string {
	for _, name := range pending {
		content, err := fs.ReadFile(r.Migrations, name)
		if err != nil {
			r.Log.Error("read migration", "name", name, "err", err)
			return name
		}
		tx, err := r.Pair.BeginImmediate(ctx)
		if err != nil {
			r.Log.Error("begin migration tx", "name", name, "err", err)
			return name
		}
		if _, err := tx.ExecContext(ctx, string(content)); err != nil {
			_ = tx.Rollback()
			r.Log.Error("migration sql failed", "name", name, "err", err)
			return name
		}
		if _, err := tx.ExecContext(
			ctx,
			`INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)`,
			name, r.nowUnix(),
		); err != nil {
			_ = tx.Rollback()
			r.Log.Error("record schema_migrations", "name", name, "err", err)
			return name
		}
		if err := tx.Commit(); err != nil {
			r.Log.Error("commit migration", "name", name, "err", err)
			return name
		}
		r.Log.Info("migration applied", "name", name)
	}
	return ""
}

func (r *Runner) refreshNoteCount(ctx context.Context) {
	var n int
	row := r.Pair.Reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM notes`)
	if err := row.Scan(&n); err != nil {
		cur := r.store.Status(ctx)
		cur.NotesIndexed = 0
		r.store.set(cur)
		return
	}
	cur := r.store.Status(ctx)
	cur.NotesIndexed = n
	r.store.set(cur)
}

// RebuildAndReindex implements Path 2. Called by
// api.Server.PostAdminReindex with mode=full.
//
// Lifecycle:
//
//  1. Set Status = Rebuilding so admin/status surfaces the progress
//     overlay.
//  2. BEGIN IMMEDIATE; DROP every derived table; COMMIT. The drop
//     list is derived at runtime from the embedded migrations via
//     deriveDropStatements — newer migrations' tables drop first,
//     schema_migrations drops last. Adding a new NNN_*.sql migration
//     is automatically picked up; no manual list maintenance.
//  3. Re-run every migration on the clean schema via discoverPending +
//     applyAll. If any migration breaks on the now-clean schema, the
//     whole rebuild is unrecoverable (Path 3) — there is no prior
//     schema to fall back to.
//  4. Invoke r.Path2Rebuild(ctx) — bridge to *index.Indexer.Reconcile
//     that walks the filesystem and repopulates the notes table.
//  5. Status = OK on success; Status = Unrecoverable + wrapped
//     ErrUnrecoverable on any failure (the composition root must
//     refuse to start the listener; the user must restore-from-backup
//     or wipe the data dir).
//
// The api.Server.PostAdminReindex handler holds reindexBusy for the
// entire call; combined with Pair.Writer.SetMaxOpenConns(1), no
// concurrent Service.Update can interleave with the DROP.
func (r *Runner) RebuildAndReindex(ctx context.Context) (Status, error) {
	r.store.set(Status{State: StateRebuilding, LogsPath: r.LogsPath})

	dropStatements, err := deriveDropStatements(r.Migrations)
	if err != nil {
		out := Status{State: StateUnrecoverable, LogsPath: r.LogsPath}
		r.store.set(out)
		return out, fmt.Errorf("%w: derive drop list: %v", ErrUnrecoverable, err)
	}

	tx, err := r.Pair.BeginImmediate(ctx)
	if err != nil {
		out := Status{State: StateUnrecoverable, LogsPath: r.LogsPath}
		r.store.set(out)
		return out, fmt.Errorf("%w: rebuild begin: %v", ErrUnrecoverable, err)
	}
	for _, stmt := range dropStatements {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			_ = tx.Rollback()
			out := Status{State: StateUnrecoverable, LogsPath: r.LogsPath}
			r.store.set(out)
			return out, fmt.Errorf("%w: drop: %v", ErrUnrecoverable, err)
		}
	}
	if err := tx.Commit(); err != nil {
		out := Status{State: StateUnrecoverable, LogsPath: r.LogsPath}
		r.store.set(out)
		return out, fmt.Errorf("%w: drop commit: %v", ErrUnrecoverable, err)
	}

	pending, err := r.discoverPending(ctx)
	if err != nil {
		out := Status{State: StateUnrecoverable, LogsPath: r.LogsPath}
		r.store.set(out)
		return out, fmt.Errorf("%w: discover: %v", ErrUnrecoverable, err)
	}
	if failed := r.applyAll(ctx, pending); failed != "" {
		out := Status{
			State:           StateUnrecoverable,
			FailedMigration: failed,
			LogsPath:        r.LogsPath,
		}
		r.store.set(out)
		return out, fmt.Errorf("%w: migration %s broken on clean schema", ErrUnrecoverable, failed)
	}

	if r.Path2Rebuild == nil {
		out := Status{State: StateUnrecoverable, LogsPath: r.LogsPath}
		r.store.set(out)
		return out, fmt.Errorf("%w: Path2Rebuild not wired", ErrUnrecoverable)
	}
	n, err := r.Path2Rebuild(ctx)
	if err != nil {
		out := Status{State: StateUnrecoverable, LogsPath: r.LogsPath}
		r.store.set(out)
		return out, fmt.Errorf("%w: rebuild: %v", ErrUnrecoverable, err)
	}
	r.store.set(Status{State: StateOK, LogsPath: r.LogsPath, NotesIndexed: n})
	return r.store.Status(ctx), nil
}
