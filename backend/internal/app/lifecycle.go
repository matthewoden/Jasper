package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/matthewoden/jasper/backend/internal/api"
	"github.com/matthewoden/jasper/backend/internal/db/migrate"
	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/internal/static"
	"github.com/matthewoden/jasper/backend/internal/wshub"
	"github.com/matthewoden/jasper/backend/migrations"
)

// notesDirFor returns <dataDir>/notes — the source-of-truth directory
// per DESIGN.md §4.1. Centralized so app.New and lifecycle agree.
func notesDirFor(dataDir string) string { return filepath.Join(dataDir, "notes") }

// EnsureDataDir creates <dataDir>/{notes,storage} with 0o755 perms if
// missing. 0o755 (not 0o700) is intentional per CONTEXT.md / threat
// model T-01-04-07: Jasper runs as the user, the data dir lives under
// the user's home, and 0o755 matches the prevailing convention for
// app-data dirs on macOS / Linux. A more restrictive 0o700 default
// would surprise external sync tools (Syncthing, iCloud, git) that
// expect to walk the tree.
func EnsureDataDir(dataDir string) error {
	for _, sub := range []string{"notes", "storage"} {
		if err := os.MkdirAll(filepath.Join(dataDir, sub), 0o755); err != nil {
			return fmt.Errorf("ensure %s: %w", sub, err)
		}
	}
	return nil
}

// SeedScratchpadIfMissing writes notes.ScratchpadWelcome to
// <dataDir>/notes/scratchpad.md ONLY if the file does not already
// exist. Idempotent — safe to call on every startup. Per CONTEXT.md
// D-08 / UI-SPEC §Copywriting Contract.
//
// Uses fsstore.AtomicWrite per DATA-13 / Pitfall 3 — every byte that
// reaches the data root must go through temp+fsync+rename+fsync(parent).
func SeedScratchpadIfMissing(dataDir string, log *slog.Logger) error {
	path := filepath.Join(notesDirFor(dataDir), notes.ScratchpadRelPath)
	if _, err := os.Stat(path); err == nil {
		log.Info("scratchpad already exists; skipping seed", "path", path)
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("stat scratchpad: %w", err)
	}
	if err := fsstore.AtomicWrite(path, []byte(notes.ScratchpadWelcome)); err != nil {
		return fmt.Errorf("seed scratchpad: %w", err)
	}
	log.Info("seeded scratchpad", "path", path, "bytes", len(notes.ScratchpadWelcome))
	return nil
}

// Run executes the Phase 2 startup sequence and serves until ctx is
// canceled. On ctx cancellation a graceful shutdown is attempted with
// a 5-second deadline.
//
// Steps (DESIGN.md §6.1 — listener gated until migrate + reindex
// complete):
//
//  1. EnsureDataDir — mkdir <DataDir>/{notes,storage}.
//  2. SeedScratchpadIfMissing — write the welcome template if absent.
//  3. mkdir <DataDir>/storage and <DataDir>/storage/logs (the migration
//     runner expects them).
//  4. sqlite.Open — open the writer/reader Pair on app.db.
//     pair is opened before runner.Run regardless of outcome; Close on
//     the pair is always safe — it tears down both Reader and Writer
//     cleanly even if the migration runner returned ErrUnrecoverable
//     / ErrDiskFull. (W-3.)
//  5. Build *index.Indexer + *migrate.Runner; wire Path2Rebuild.
//  6. runner.Run — apply pending migrations on the live DB. Three
//     outcomes:
//     - StateOK / StateRolledBack → continue to step 7.
//     - ErrDiskFull → install the disk-full static handler and
//     serve it on the listener (the user must free space and
//     restart the binary).
//     - ErrUnrecoverable → install the unrecoverable static
//     handler and serve it on the listener.
//  7. indexer.Reconcile(ModeIncremental) — DATA-09 startup delta scan.
//     Only runs when state != Unrecoverable.
//  8. Rebuild api.Server with full wiring (NewServerWithIndex 5-arg
//     form — B-2 locked) and replace a.handler.
//  9. net.Listen + http.Server.Serve, graceful shutdown on ctx.Done.
//
// ReadHeaderTimeout is set per threat model T-01-04-05 to mitigate
// slowloris-style attacks. Full ReadTimeout / WriteTimeout are
// deferred to Phase 4 alongside the WebSocket hub timeout config.
func (a *App) Run(ctx context.Context) error {
	// 1. Ensure data dir + notes/ + storage/ exist.
	if err := EnsureDataDir(a.cfg.DataDir); err != nil {
		return err
	}
	// 2. Seed scratchpad.md if missing.
	if err := SeedScratchpadIfMissing(a.cfg.DataDir, a.cfg.Logger); err != nil {
		return err
	}

	// 3. Phase 2 NEW — mkdir <DataDir>/storage + storage/logs.
	dbPath := storageDBPath(a.cfg.DataDir)
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return fmt.Errorf("ensure storage dir: %w", err)
	}
	logsDir := filepath.Join(a.cfg.DataDir, "storage", "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return fmt.Errorf("ensure logs dir: %w", err)
	}

	// 4. Phase 2 NEW — open sqlite Pair.
	backupPath := dbPath + ".backup"
	logsPath := filepath.Join(logsDir, "jasper.log")

	// 4a. Disk-space preflight BEFORE sqlite.Open. This must run first
	// so JASPER_TEST_FORCE_DISK_FULL=1 — and the production case of a
	// data volume actually being full — surface as ErrDiskFull rather
	// than a sqlite NOTADB / ping error from a corrupt or unreachable
	// app.db. The runner's own preflight inside Run() still fires; this
	// is the boot-time gate that catches it before we ever touch the DB.
	if err := migrate.PreflightFreeSpace(dbPath); err != nil {
		if errors.Is(err, migrate.ErrDiskFull) {
			a.cfg.Logger.Error("boot failed: disk-full preflight aborted before sqlite.Open — serving static error page",
				"err", err, "data_dir", a.cfg.DataDir, "logs_path", logsPath)
			a.diskFullHandler = newBootErrorHandler(
				"disk-full.html",
				buildDiskFullData(dbPath, a.cfg.DataDir),
			)
			a.handler = a.diskFullHandler
			return a.serveListener(ctx)
		}
		return fmt.Errorf("disk preflight: %w", err)
	}

	pair, err := sqlite.Open(ctx, dbPath)
	if err != nil {
		return fmt.Errorf("sqlite open: %w", err)
	}
	// pair is opened before runner.Run regardless of outcome; Close on
	// the pair is always safe — it tears down both Reader and Writer
	// cleanly even if the migration runner returned ErrUnrecoverable /
	// ErrDiskFull. (W-3.)
	defer func() { _ = pair.Close() }()
	a.pair = pair

	// 5. Phase 2 NEW — build Runner + Indexer.
	notesDir := notesDirFor(a.cfg.DataDir)
	a.indexer = index.New(pair, notesDir, a.cfg.Logger)

	// MigrationsOverride is a test-only injection point. Production
	// callers leave it nil; the embedded migrations.FS below is used.
	// B-3 acceptance gate requires the literal `Migrations: migrations.FS`
	// to appear in this file — we satisfy it by spelling the production
	// expression directly in the struct literal and override AFTER
	// constructing the Runner via the writable Migrations field.
	a.runner = migrate.NewRunner(migrate.RunnerOptions{
		DBPath:     dbPath,
		BackupPath: backupPath,
		LogsPath:   logsPath,
		Migrations: migrations.FS,
		Pair:       pair,
		Log:        a.cfg.Logger,
	})
	if a.cfg.MigrationsOverride != nil {
		a.runner.Migrations = a.cfg.MigrationsOverride
	}
	// Wire Path 2 callback: when RebuildAndReindex needs to walk the
	// filesystem, it calls Indexer.Reconcile(ModeFull).
	a.runner.Path2Rebuild = func(ctx context.Context) (int, error) {
		return a.indexer.Reconcile(ctx, index.ModeFull)
	}

	// 6. Phase 2 NEW — run migrations.
	status, runErr := a.runner.Run(ctx)
	if runErr != nil {
		// Disk-full or unrecoverable: serve static error page; do NOT exit.
		if errors.Is(runErr, migrate.ErrDiskFull) {
			a.cfg.Logger.Error("boot failed: disk-full preflight aborted — serving static error page",
				"err", runErr, "data_dir", a.cfg.DataDir, "logs_path", logsPath)
			a.diskFullHandler = newBootErrorHandler(
				"disk-full.html",
				buildDiskFullData(dbPath, a.cfg.DataDir),
			)
			a.handler = a.diskFullHandler
			return a.serveListener(ctx)
		}
		if errors.Is(runErr, migrate.ErrUnrecoverable) {
			a.cfg.Logger.Error("boot failed: unrecoverable migration state — serving static error page",
				"err", runErr, "data_dir", a.cfg.DataDir, "logs_path", logsPath)
			a.diskFullHandler = newBootErrorHandler(
				"unrecoverable.html",
				buildUnrecoverableData(logsPath),
			)
			a.handler = a.diskFullHandler
			return a.serveListener(ctx)
		}
		return fmt.Errorf("migrate run: %w", runErr)
	}
	a.cfg.Logger.Info("migration runner status",
		"state", status.State,
		"failed_migration", status.FailedMigration)

	// 6b. Phase 6 D-11 / TAGS-EXT-03 — one-time frontmatter scaffold
	// injection. Idempotent: after the first successful run the marker row
	// in schema_migrations short-circuits the walk on every subsequent
	// boot. Runs INSIDE the listener gate (DESIGN.md §6.1) so the HTTP
	// server only starts accepting connections once every .md file under
	// notesDir has frontmatter. Skipped when state == Unrecoverable.
	if status.State != migrate.StateUnrecoverable {
		if err := InjectFrontmatterScaffoldMigration(ctx, pair.Writer, notesDir, a.cfg.Logger); err != nil {
			return fmt.Errorf("lifecycle: frontmatter scaffold migration: %w", err)
		}
	}

	// 7. Phase 2 NEW — incremental reindex (DATA-09).
	// Skip ONLY when state == Unrecoverable (which would have been
	// caught above as ErrUnrecoverable; this is defense in depth).
	// A rolled_back state means the failed migration could be a
	// future column-add (e.g. 002_tags.sql) which the notes table
	// does not need; reconciling against the prior schema still works.
	//
	// Phase 6 Plan 06-06: switched from Reconcile to ReconcileWithRegistry.
	// The registry pointer is nil here because notesSvc (and its embedded
	// Registry) is built in step 8 — after the startup reconcile. Nil
	// registry is safe: ReconcileWithRegistry only uses it for D-20
	// ambiguity resolution in SyncBacklinks, which is a no-op when nil.
	// Step 8a Hydrate() populates the registry from indexed summaries
	// before the listener opens so all subsequent operations resolve UUIDs.
	if status.State != migrate.StateUnrecoverable {
		n, err := a.indexer.ReconcileWithRegistry(ctx, index.ModeIncremental, nil)
		if err != nil {
			a.cfg.Logger.Warn("startup incremental reindex failed (non-fatal)", "err", err)
		} else {
			a.cfg.Logger.Info("startup incremental reindex done", "notes_indexed", n)
		}
	}

	// 8. Phase 2 NEW — rebuild api.Server with full wiring.
	// The handler installed by New() pointed at a nil-everything Server;
	// replace with the real one now that pair / indexer / runner exist.

	// Phase 4: construct WS hub so it can be injected into notes.Service
	// as the third port. Lives inside step 8 so it is wired BEFORE step
	// 9's serveListener — the listener gate (SYNC-09) naturally extends
	// to the WS hub because the hub does not accept connections until the
	// listener opens (chi route mounted on the same http.Server).
	hub := wshub.New(a.cfg.Logger)
	a.mu.Lock()
	a.hub = hub
	a.mu.Unlock()

	files := fsstore.NewStore(notesDir)
	notesSvc := notes.NewService(files, a.indexer, hub, a.cfg.Logger)

	// 8a. Phase 3 Plan 03-04 NEW — hydrate the in-memory registry from
	// indexed summaries so any UUID returned by GET /notes / GET /tree
	// resolves via Service.Get. ScratchpadUUID is included automatically
	// because the indexer's chooseID assigns it during reconcile when it
	// sees scratchpad.md.
	//
	// Listener-gating contract from DESIGN.md §6.1 is preserved: this
	// runs strictly before serveListener (step 9), so no incoming
	// connection observes the registry in its pre-hydration (single-
	// scratchpad-only) state. T-03-04-07 mitigation.
	//
	// Skip cleanly when state == Unrecoverable (the indexer DB tables
	// may not exist) — list would error and nothing is gained.
	if a.indexer != nil && status.State != migrate.StateUnrecoverable {
		if summaries, err := a.indexer.List(ctx); err == nil {
			notesSvc.Registry().Hydrate(summaries)
			a.cfg.Logger.Info("registry hydrated", "count", len(summaries))
			// BUG-02 fix (Phase 6.5 Plan 08): startup ReconcileWithRegistry runs
			// with nil registry (notes service not yet built), leaving all backlinks
			// with target_id = NULL (pending). After registry hydration, run a
			// targeted second-pass to resolve pending rows by title lookup.
			// Non-fatal: partial failures leave rows pending (resolved on next save).
			if rErr := a.indexer.ResolvePendingBacklinks(ctx, notesSvc.Registry()); rErr != nil {
				a.cfg.Logger.Warn("startup: pending backlinks resolution failed (non-fatal)", "err", rErr)
			} else {
				a.cfg.Logger.Info("startup: pending backlinks resolved")
			}
		} else {
			a.cfg.Logger.Warn("registry hydrate: List failed (proceeding with empty registry)",
				"err", err)
		}
	}
	a.mu.Lock()
	a.notesSvc = notesSvc
	a.mu.Unlock()

	// B-2 locked 5-arg form: (notesSvc, status, runner, index, log).
	// a.runner implements migrate.StatusProvider, so it's passed twice:
	// once as the status reader for /admin/status and once as the
	// runner for /admin/reindex.
	apiServer := api.NewServerWithIndex(notesSvc, a.runner, a.runner, a.indexer, hub, a.cfg.Logger, a.cfg.DataDir)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(securityHeadersMiddleware) // Plan 05-04 — SECURITY-01, SECURITY-04, D-35
	r.Use(requestLogger(a.cfg.Logger))
	si := api.NewStrictHandler(apiServer, nil)
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(maxBodyBytes(maxRequestBodyBytes))
		r.Use(sessionIDMiddleware)            // Phase 4 — SYNC-02 X-Session-ID extraction
		r.Use(api.ConfigStrictBodyMiddleware) // D-40: strict JSON for PUT /config
		api.HandlerFromMux(si, r)
		// Mount /ws AFTER HandlerFromMux — chi uses last-registration-wins,
		// so this overrides the oapi-codegen GetApiV1Ws stub (which returns
		// 400). wshub.Hub.ServeHTTP handles all WS upgrades. (Pitfall 8:
		// the comment "BEFORE" referred to logical precedence; the correct
		// implementation is AFTER so the hub's registration wins — confirmed
		// by chi routing tests.)
		r.Get("/ws", hub.ServeHTTP)
	})
	r.Mount("/", static.Handler())
	a.handler = r

	// 9. serve until ctx cancellation
	return a.serveListener(ctx)
}

// serveListener is the listen + graceful-shutdown body, factored into
// its own method so the boot-error path can also call it. Returns nil
// on graceful shutdown; a wrapped error if Listen / Serve fails.
func (a *App) serveListener(ctx context.Context) error {
	srv := &http.Server{
		Addr:              a.cfg.ListenAddr,
		Handler:           a.handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	ln, err := net.Listen("tcp", a.cfg.ListenAddr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", a.cfg.ListenAddr, err)
	}
	a.cfg.Logger.Info("jasper listening", "addr", a.cfg.ListenAddr, "data_dir", a.cfg.DataDir)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
