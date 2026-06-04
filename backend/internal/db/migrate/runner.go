package migrate

import (
	"context"
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
// root (Plan 02-06) MUST refuse to start the HTTP listener and serve
// the static error page instead. Callers detect with errors.Is.
var ErrUnrecoverable = errors.New("migrate: unrecoverable schema state — manual intervention required")

// migrationFilenamePattern enforces the migration-naming convention:
//
//	^[0-9]{3}_[a-z0-9_]+\.sql$
//
// e.g. "001_initial.sql", "002_add_tags.sql". Files in migrations.FS
// that don't match are an error — the runner refuses to silently skip
// them because that would mask a misconfigured migrations directory.
var migrationFilenamePattern = regexp.MustCompile(`^[0-9]{3}_[a-z0-9_]+\.sql$`)

// RunnerOptions is the constructor input for NewRunner. All fields are
// required EXCEPT NowUnix / DiskFreeFn / Log which default to production
// implementations when nil.
type RunnerOptions struct {
	DBPath     string       // <dataDir>/storage/app.db (absolute)
	BackupPath string       // <dataDir>/storage/app.db.backup (absolute)
	LogsPath   string       // <dataDir>/storage/logs/jasper.log (surfaced via MigrationStatus.LogsPath)
	Migrations fs.FS        // migrations.FS from backend/migrations
	Pair       *sqlite.Pair // writer/reader pair from internal/db/sqlite
	Log        *slog.Logger
	NowUnix    func() int64                      // injectable clock for tests; defaults to time.Now().Unix
	DiskFreeFn func(path string) (uint64, error) // injectable for tests; production default reads syscall.Statfs
}

// Runner is the three-path orchestrator (DESIGN.md §4.4).
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
//  7. Path 2 (RebuildAndReindex) is triggered by POST /admin/reindex —
//     wired by Plan 02-04b; the body of RebuildAndReindex lands in
//     that plan. Path 3 (Unrecoverable) fires when restore itself
//     fails OR when Path 2 also fails.
type Runner struct {
	DBPath       string
	BackupPath   string
	LogsPath     string
	Migrations   fs.FS
	Pair         *sqlite.Pair
	Log          *slog.Logger
	Path2Rebuild func(context.Context) (notesIndexed int, err error) // wired by Plan 02-04b in app.New

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
		// Default to the package-level freeBytes so production reaches
		// syscall.Statfs (and the JASPER_TEST_FORCE_DISK_FULL hook stays
		// active) without an extra layer of indirection. Tests inject
		// their own mock by passing DiskFreeFn explicitly.
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
	// 1. preflight (DATA-07)
	if err := r.preflight(); err != nil {
		// disk-full halt: surface the error so the composition root
		// serves the static disk-full.html page in response.
		r.Log.Error("migrate preflight failed", "err", err)
		out := Status{State: StateUnrecoverable, LogsPath: r.LogsPath}
		r.store.set(out)
		return out, err
	}

	// 2. discover pending. We also remember whether ANY migrations were
	// applied before this Run started — the "prior-schema-exists" gate
	// for Path 1. If schema_migrations was empty (or didn't exist), a
	// failed migration cannot "roll back to a previous schema" because
	// there isn't one; that scenario is Path 3 directly.
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

	// 4. backup (no-op on fresh DB).
	//
	// We back up unconditionally here because even an "empty" sqlite
	// file contains state we'd rather preserve (the WAL header, future
	// connection-level pragma side effects). The Path-1-vs-Path-3
	// decision is keyed on hadPriorSchema, NOT on backup-file presence.
	if err := BackupBeforeMigration(r.DBPath, r.BackupPath); err != nil {
		r.Log.Error("migrate backup failed", "err", err)
		out := Status{State: StateUnrecoverable, LogsPath: r.LogsPath}
		r.store.set(out)
		return out, fmt.Errorf("backup: %w", err)
	}

	// 5. apply each pending migration
	if failed := r.applyAll(ctx, pending); failed != "" {
		// Path 1 — restore backup. Two outcomes:
		//   (a) the backup file exists, schema_migrations had at least
		//       one row before this Run started, and restore succeeds
		//       → state RolledBack, app continues on the prior schema.
		//   (b) no prior-schema exists (hadPriorSchema=false), OR
		//       the backup file is missing, OR restore itself fails
		//       → Path 3, state Unrecoverable.
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
			// backup-restore itself failed → Path 3.
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
		return r.store.Status(ctx), nil // app keeps running on prior schema
	}

	// 6a. success: delete backup, status OK
	if err := DeleteBackup(r.BackupPath); err != nil {
		r.Log.Warn("post-success backup delete failed (non-fatal)", "err", err)
	}
	r.store.set(Status{State: StateOK, LogsPath: r.LogsPath})
	r.refreshNoteCount(ctx)
	return r.store.Status(ctx), nil
}

// preflight wraps PreflightFreeSpace using the injected diskFreeBytes
// function so tests can force ErrDiskFull. The package-level
// PreflightFreeSpace reads the unmocked freeBytes by default; this
// helper redirects through r.diskFreeBytes for tests.
func (r *Runner) preflight() error {
	// We re-implement the PreflightFreeSpace shape here so the disk-free
	// callable can be injected. PreflightFreeSpace itself is the
	// production path — the runner uses it indirectly when DiskFreeFn
	// was left at its default (freeBytes), but tests pass a different
	// DiskFreeFn and need that to flow.
	info, err := osStatPath(r.DBPath)
	if err != nil {
		if isNotExistErr(err) {
			return nil // fresh DB; nothing to back up
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

// discoverPending reads r.Migrations, sorts entries lex, and returns
// those whose filename is NOT in schema_migrations.version. Filenames
// must match migrationFilenamePattern; non-matching entries are an
// error (don't silently skip — that masks a misconfigured directory).
//
// schema_migrations may not exist on a fresh DB. In that case, every
// migration in r.Migrations is pending.
//
// Kept as a package-internal helper for the discoverPending unit tests;
// Runner.Run uses pendingFromApplied so it can hold onto the applied
// set for the Path-1-vs-Path-3 decision.
func (r *Runner) discoverPending(ctx context.Context) ([]string, error) {
	applied, err := r.appliedMigrations(ctx)
	if err != nil {
		return nil, err
	}
	return r.pendingFromApplied(ctx, applied)
}

// pendingFromApplied is discoverPending's second half: given the set of
// already-applied versions, walk r.Migrations in lex order and return
// the names that aren't in `applied`.
func (r *Runner) pendingFromApplied(_ context.Context, applied map[string]struct{}) ([]string, error) {
	entries, err := fs.ReadDir(r.Migrations, ".")
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

// appliedMigrations returns the set of versions present in
// schema_migrations. If the table doesn't exist yet (fresh DB), returns
// an empty set.
func (r *Runner) appliedMigrations(ctx context.Context) (map[string]struct{}, error) {
	out := make(map[string]struct{})
	// Existence check first so we don't return SQL-level errors on a
	// fresh DB. modernc.org/sqlite returns "no such table" wrapped as
	// a Go error; rather than match the message, query sqlite_master.
	var tableName string
	row := r.Pair.Reader.QueryRowContext(ctx,
		`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
	if err := row.Scan(&tableName); err != nil {
		// Distinguish "no row" (fresh DB, table doesn't exist) from a
		// real error. database/sql returns sql.ErrNoRows on no-row.
		if errors.Is(err, sqlNoRows()) {
			return out, nil
		}
		return nil, fmt.Errorf("check schema_migrations table: %w", err)
	}

	rows, err := r.Pair.Reader.QueryContext(ctx, `SELECT version FROM schema_migrations`)
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

// applyAll runs each pending migration in its own BEGIN IMMEDIATE
// transaction. Returns the filename of the first failure (or "" on
// success). The full SQL exec error is logged server-side; the wire
// format only carries the filename (UI-SPEC §Surface 1 voice rules /
// threat T-02-03-03 — no PII / SQL leak to the client).
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
		if _, err := tx.ExecContext(ctx,
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

// refreshNoteCount populates Status.NotesIndexed from
// SELECT COUNT(*) FROM notes. The notes table may not exist yet during
// Path 1 (the failed migration could be 001_initial.sql itself), so any
// query error sets NotesIndexed = 0 rather than failing the runner.
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

// RebuildAndReindex implements Path 2 (DATA-10). Called by
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
//  4. Invoke r.Path2Rebuild(ctx) — wired by Plan 02-06's app.New as a
//     bridge to *index.Indexer.Reconcile(ctx, ModeFull). This walks the
//     filesystem and repopulates the notes table.
//  5. Status = OK on success; Status = Unrecoverable + wrapped
//     ErrUnrecoverable on any failure (the composition root must
//     refuse to start the listener; the user must restore-from-backup
//     or wipe the data dir).
//
// T-02-04b-08 mitigation: the api.Server.PostAdminReindex handler
// holds reindexBusy for the entire call; combined with
// Pair.Writer.SetMaxOpenConns(1), no concurrent Service.Update can
// interleave with the DROP.
//
// Historical note: the drop list was previously hardcoded. Phase 8
// added `004_mcp_grants.sql` (mcp_write_grants) without updating the
// list, which caused every rebuild to 503 "unrecoverable" because
// re-applying 004 hit a duplicate CREATE TABLE. Resolved in commit
// 0240d36 (hardcoded fix) then structurally eliminated by switching
// to deriveDropStatements.
func (r *Runner) RebuildAndReindex(ctx context.Context) (Status, error) {
	r.store.set(Status{State: StateRebuilding, LogsPath: r.LogsPath})

	// 1. Derive drop list from the embedded migrations and drop every
	// derived table so applyAll can re-create them from a clean slate.
	// Order (newest migration first, schema_migrations last) is handled
	// inside deriveDropStatements.
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

	// 2. Re-discover pending (now ALL migrations are pending again)
	// and re-apply.
	pending, err := r.discoverPending(ctx)
	if err != nil {
		out := Status{State: StateUnrecoverable, LogsPath: r.LogsPath}
		r.store.set(out)
		return out, fmt.Errorf("%w: discover: %v", ErrUnrecoverable, err)
	}
	if failed := r.applyAll(ctx, pending); failed != "" {
		// Migrations broke on a clean schema → Path 3.
		out := Status{
			State:           StateUnrecoverable,
			FailedMigration: failed,
			LogsPath:        r.LogsPath,
		}
		r.store.set(out)
		return out, fmt.Errorf("%w: migration %s broken on clean schema", ErrUnrecoverable, failed)
	}

	// 3. Path2Rebuild = full re-index; wired by app.New (Plan 02-06).
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
