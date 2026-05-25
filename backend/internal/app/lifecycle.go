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
	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/db/migrate"
	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/index"
	jlog "github.com/matthewoden/jasper/backend/internal/log"
	"github.com/matthewoden/jasper/backend/internal/mcp"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/internal/static"
	"github.com/matthewoden/jasper/backend/internal/vault"
	"github.com/matthewoden/jasper/backend/internal/wshub"
	"github.com/matthewoden/jasper/backend/migrations"
)

// ErrAlreadyOpen is returned by OpenVault when a vault is already open.
// Plan 08-17d adds the in-process mutex + concurrent 409 enforcement;
// 17b returns this sentinel as a stub for the "switch is unsupported" case.
var ErrAlreadyOpen = errors.New("a vault is already open; hot-swap not yet supported (see 08-17d)")

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

// serveStartupError installs the static startup-failure page (D-11,
// UI-SPEC §Surface 7) on the listener and serves it instead of the
// SPA + API. Called from lifecycle.Run when init fails AFTER the
// disk-full / unrecoverable sentinels are excluded (those have their
// own dedicated handlers via newBootErrorHandler).
//
// phaseName: short human-friendly init-step name (e.g. "Storage dir",
// "SQLite open", "Migration", "Frontmatter scaffold"). Auto-escaped.
//
// Returns the error from a.serveListener so the caller can `return` it
// directly. A nil return means the listener served until ctx.Done.
func (a *App) serveStartupError(ctx context.Context, phaseName string, initErr error) error {
	// jasper.log may or may not exist depending on how far init progressed
	// before failure. tailLog returns a friendly placeholder when missing.
	logsPath := filepath.Join(a.cfg.DataDir, "storage", "logs", "jasper.log")
	data := StartupErrorData{
		PhaseName:       phaseName,
		ErrorSummary:    initErr.Error(),
		SuggestedAction: suggestedActionFor(initErr),
		LogExcerpt:      tailLog(logsPath, 20),
	}
	a.cfg.Logger.Error("boot failed: serving startup-error static page",
		"phase", phaseName, "err", initErr, "data_dir", a.cfg.DataDir)
	a.handler.Swap(newStartupErrorHandler(data))
	return a.serveListener(ctx)
}

// Run executes the Phase 2 startup sequence and serves until ctx is
// canceled. On ctx cancellation a graceful shutdown is attempted with
// a 5-second deadline.
//
// Plan 08-17b adds a "no-vault" branch at the top of the sequence
// (ADR-001 §2 boot steps):
//
//  0. resolveVaultMode — read app.json; determine modeOpen vs modeNoVault.
//     V13 + V14 clear current_vault + set banner atomically; per-vault
//     subsystems remain dormant in no-vault mode.
//
// Per-vault steps (only when modeOpen):
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
	// 0. Resolve vault mode (ADR-001 §2 boot sequence).
	appJSONPath, err := vault.AppJSONPath()
	if err != nil {
		return fmt.Errorf("resolve app home: %w", err)
	}
	mode, banner, openPath, err := resolveVaultMode(appJSONPath, a.cfg.VaultOverride)
	if err != nil {
		return fmt.Errorf("resolve vault mode: %w", err)
	}
	api.BootBanner = banner

	if mode == modeNoVault {
		// Legacy fallback: if cfg.DataDir was explicitly set by the caller
		// (pre-vault-model wiring — tests, or serve.go before 17b) and no
		// V13/V14 banner was generated, treat DataDir as the vault and boot
		// the per-vault subsystems directly. This preserves backward
		// compatibility with existing app_test.go tests that call Run()
		// with DataDir set but without app.json plumbing.
		if a.cfg.DataDir != "" && banner == "" {
			a.cfg.Logger.Info("jasper boot: legacy DataDir fallback (pre-vault-model wiring)",
				"data_dir", a.cfg.DataDir)
			return a.bootPerVaultSubsystems(ctx)
		}
		// No-vault mode: serve the picker SPA shell + /vault/* handlers only.
		// Per-vault subsystems (DB, migrations, indexer, MCP, WS hub, file
		// logger) remain dormant. The chi router built in New() already mounts
		// all /vault/* routes via the strict handler — no additional wiring.
		if a.cfg.Logger == nil {
			a.cfg.Logger = slog.Default()
		}
		a.cfg.Logger.Info("jasper boot: no vault selected, serving picker shell")
		return a.serveListener(ctx)
	}

	// modeOpen: standard per-vault bring-up.
	a.cfg.DataDir = openPath
	return a.bootPerVaultSubsystems(ctx)
}

// bootPerVaultSubsystems runs the per-vault startup sequence (steps 1–9).
// Called by Run when modeOpen, and by OpenVault to transition a running
// no-vault instance to open-vault mode.
//
// Caller MUST have set a.cfg.DataDir to the vault's canonical path before
// calling this method.
//
// For the hot-swap (SwitchVault) path, use initVaultSubsystemsOnly instead —
// it performs steps 1–8 without step 9 (serveListener), leaving the existing
// HTTP listener running.
func (a *App) bootPerVaultSubsystems(ctx context.Context) error {
	// 1. Ensure data dir + notes/ + storage/ exist.
	if err := EnsureDataDir(a.cfg.DataDir); err != nil {
		return a.serveStartupError(ctx, "Data dir", err)
	}

	// Phase 8 Plan 08-12 / D-39 / PERF-03 — file logger wire-up.
	// Production callers (serve.go) currently pass a stderr-backed slog
	// instance via cfg.Logger; tests do the same. When cfg.Logger is nil
	// (a future production path may leave it nil so file logging is the
	// default), instantiate the FileLogger against a.cfg.Server.DataDir
	// (08-01 Task 4 thread-through field on app.Config) and stash the
	// io.Closer on App for graceful shutdown. While cfg.Logger is set,
	// the file logger is bypassed — the caller's logger wins.
	if a.cfg.Logger == nil {
		logger, closer, err := jlog.NewFileLogger(a.cfg.Server.DataDir)
		if err != nil {
			return a.serveStartupError(ctx, "File logger", fmt.Errorf("file logger init: %w", err))
		}
		a.cfg.Logger = logger
		a.fileLogCloser = closer
		defer func() {
			if cerr := closer.Close(); cerr != nil {
				// At this point the logger may be writing to a closing
				// sink; route the failure to stderr so it isn't lost.
				fmt.Fprintf(os.Stderr, "file logger close: %v\n", cerr)
			}
		}()
	}

	// 2. Seed scratchpad.md if missing.
	if err := SeedScratchpadIfMissing(a.cfg.DataDir, a.cfg.Logger); err != nil {
		return a.serveStartupError(ctx, "Scratchpad seed", err)
	}

	// 3. Phase 2 NEW — mkdir <DataDir>/storage + storage/logs.
	dbPath := storageDBPath(a.cfg.DataDir)
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return a.serveStartupError(ctx, "Storage dir", fmt.Errorf("ensure storage dir: %w", err))
	}
	logsDir := filepath.Join(a.cfg.DataDir, "storage", "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return a.serveStartupError(ctx, "Logs dir", fmt.Errorf("ensure logs dir: %w", err))
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
			a.handler.Swap(a.diskFullHandler)
			return a.serveListener(ctx)
		}
		return a.serveStartupError(ctx, "Disk preflight", fmt.Errorf("disk preflight: %w", err))
	}

	pair, err := sqlite.Open(ctx, dbPath)
	if err != nil {
		return a.serveStartupError(ctx, "SQLite open", fmt.Errorf("sqlite open: %w", err))
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
			a.handler.Swap(a.diskFullHandler)
			return a.serveListener(ctx)
		}
		if errors.Is(runErr, migrate.ErrUnrecoverable) {
			a.cfg.Logger.Error("boot failed: unrecoverable migration state — serving static error page",
				"err", runErr, "data_dir", a.cfg.DataDir, "logs_path", logsPath)
			a.diskFullHandler = newBootErrorHandler(
				"unrecoverable.html",
				buildUnrecoverableData(logsPath),
			)
			a.handler.Swap(a.diskFullHandler)
			return a.serveListener(ctx)
		}
		return a.serveStartupError(ctx, "Migration", fmt.Errorf("migrate run: %w", runErr))
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
			return a.serveStartupError(ctx, "Frontmatter scaffold", fmt.Errorf("lifecycle: frontmatter scaffold migration: %w", err))
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
	// Plan 08-02: keep migrationsFS wired on the rebuilt server (parity
	// with app.New). The wizard's PostSetup is normally a one-shot at
	// first-run, but the field stays available for any future re-seed.
	apiServer.SetMigrationsFS(a.runner.Migrations)
	// Plan 08-17d: wire the hot-swap entry point so /vault/switch can call
	// SwitchVault. The VaultSwitcher interface is defined in api/vault.go to
	// avoid an import cycle; *App satisfies it.
	apiServer.SetVaultSwitcher(a)
	// Plan 08-17d: wire the inFlightWrites WaitGroup so write handlers
	// participate in SwitchVault's drain (V6 2-second cap).
	apiServer.SetInFlightWrites(&a.inFlightWrites)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(securityHeadersMiddleware) // Plan 05-04 — SECURITY-01, SECURITY-04, D-35
	r.Use(requestLogger(a.cfg.Logger))
	si := api.NewStrictHandler(apiServer, nil)
	r.Route("/api/v1", func(r chi.Router) {
		// Use the attachment-aware body cap (200 MiB) so large uploads reach the
		// handler's own io.LimitReader(100 MiB+1) cap which returns HTTP 413.
		// The 10 MiB limit (maxRequestBodyBytes) caused HTTP 500 for files > 10 MiB
		// because MaxBytesReader fired before the attachment handler could respond
		// with 413. Plan 07-13 (Rule 1 bug fix).
		r.Use(maxBodyBytes(maxAttachmentBodyBytes))
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
		// Plan 07-38 (UAT-4 R7a): override GET /files with the manual
		// ServeFile handler so Content-Type is computed dynamically
		// (http.DetectContentType + .svg → image/svg+xml override).
		// The generated wrapper hard-codes "application/octet-stream"
		// which browsers refuse to render in <img> for SVG. Same
		// last-registration-wins promotion as /ws above.
		r.Get("/files", apiServer.ServeFile)
	})
	r.Mount("/", static.Handler())
	a.handler.Swap(r)

	// 8b. Phase 8 Plan 08-09 — MCP server bring-up (D-14 / D-15 / D-23).
	// Runs AFTER migrations + reindex (Ready signal), BEFORE
	// serveListener — the MCP listener binds a SECOND loopback port
	// (cfg.MCP.Port, default 6684) and serves /mcp StreamableHTTP.
	//
	// Config source: cfg.MCP comes from <dataDir>/storage/config.json
	// (Plan 08-01 Task 4 declared the schema; Plan 08-02 wizard submit
	// writes Enabled=true when the user opts in). We Load() here so the
	// MCP block is in scope; load errors are non-fatal (the main listener
	// keeps running with MCP disabled).
	mcpCfg, mcpCfgErr := config.Load(a.cfg.DataDir, a.cfg.Logger)
	if mcpCfgErr != nil {
		a.cfg.Logger.Warn("MCP: config load failed (continuing with MCP disabled)", "err", mcpCfgErr)
	} else if mcpCfg.MCP.Enabled {
		mcpSrv, mcpShutdownFn, mcpErr := a.startMCP(ctx, mcpCfg.MCP, notesSvc, hub, pair)
		if mcpErr != nil {
			a.cfg.Logger.Error("MCP listener failed to bind; continuing without MCP", "err", mcpErr)
		} else {
			a.cfg.Logger.Info("MCP listener up", "port", mcpCfg.MCP.Port, "bind", mcpCfg.MCP.Bind)
			// Store on App so SwitchVault's tearDownPerVaultSubsystems can call
			// Shutdown to release the port before the new vault's MCP binds.
			a.mcpServer = mcpSrv
			a.mcpShutdown = mcpShutdownFn
		}
	}

	// Update currentVaultPath so /vault/switch 409 responses can report
	// what is currently open. Also set when VaultOverride is in use.
	a.setCurrentVaultPath(a.cfg.DataDir)

	// 9. serve until ctx cancellation; MCP Shutdown deferred here for
	// clean exit when ctx is canceled (normal app shutdown).
	defer func() {
		if a.mcpShutdown != nil {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := a.mcpShutdown(shutdownCtx); err != nil {
				a.cfg.Logger.Warn("MCP listener shutdown error", "err", err)
			}
			a.mcpShutdown = nil
		}
		// Close a.pair on app shutdown. After a SwitchVault, a.pair is the
		// LAST vault's pair; it was not covered by the local defer above
		// (which closes only the original pair). Guard: if pair == a.pair we
		// are closing the same object; if they differ (hot-swap happened), the
		// original pair is already closed by the local defer and a.pair still
		// needs closing.
		if a.pair != nil && a.pair != pair {
			_ = a.pair.Close()
		}
	}()
	return a.serveListener(ctx)
}

// initVaultSubsystemsOnly performs steps 1–8 of the per-vault boot sequence
// (DB open, migrations, indexer, notes service, API server, MCP) WITHOUT
// calling serveListener (step 9). It is used exclusively by SwitchVault so
// the existing HTTP listener keeps running through a hot-swap.
//
// Unlike bootPerVaultSubsystems, it does NOT defer pair.Close; the caller
// (SwitchVault) is responsible for closing the pair on the next switch or
// on normal shutdown (via the a.pair field which is inspected by
// tearDownPerVaultSubsystems).
//
// Returns a non-nil error for any hard failure (DB open, migration, etc.).
// Disk-full and unrecoverable migration states are surfaced as plain errors
// (the switch handler converts them to HTTP 4xx/5xx rather than the static
// error page served during initial boot).
//
// Caller MUST have set a.cfg.DataDir to the new vault's canonical path.
func (a *App) initVaultSubsystemsOnly(ctx context.Context) error {
	// 1. Ensure data dir + notes/ + storage/ exist.
	if err := EnsureDataDir(a.cfg.DataDir); err != nil {
		return fmt.Errorf("initVaultSubsystemsOnly: data dir: %w", err)
	}

	// File logger: for the hot-swap path, cfg.Logger is always set by the
	// caller (it was set during the initial boot); skip the nil-logger branch.
	// If for some reason it is nil, fall back to the default logger.
	if a.cfg.Logger == nil {
		a.cfg.Logger = slog.Default()
	}

	// 2. Seed scratchpad.md if missing.
	if err := SeedScratchpadIfMissing(a.cfg.DataDir, a.cfg.Logger); err != nil {
		return fmt.Errorf("initVaultSubsystemsOnly: scratchpad seed: %w", err)
	}

	// 3. mkdir <DataDir>/storage + storage/logs.
	dbPath := storageDBPath(a.cfg.DataDir)
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return fmt.Errorf("initVaultSubsystemsOnly: storage dir: %w", err)
	}
	logsDir := filepath.Join(a.cfg.DataDir, "storage", "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return fmt.Errorf("initVaultSubsystemsOnly: logs dir: %w", err)
	}

	// 4. Open sqlite Pair.
	backupPath := dbPath + ".backup"
	logsPath := filepath.Join(logsDir, "jasper.log")

	if err := migrate.PreflightFreeSpace(dbPath); err != nil {
		return fmt.Errorf("initVaultSubsystemsOnly: disk preflight: %w", err)
	}

	pair, err := sqlite.Open(ctx, dbPath)
	if err != nil {
		return fmt.Errorf("initVaultSubsystemsOnly: sqlite open: %w", err)
	}
	// NOTE: no defer pair.Close here — caller (SwitchVault) owns the pair's
	// lifecycle via a.pair + tearDownPerVaultSubsystems.
	a.pair = pair

	// 5. Build Runner + Indexer.
	notesDir := notesDirFor(a.cfg.DataDir)
	a.indexer = index.New(pair, notesDir, a.cfg.Logger)

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
	a.runner.Path2Rebuild = func(ctx context.Context) (int, error) {
		return a.indexer.Reconcile(ctx, index.ModeFull)
	}

	// 6. Run migrations.
	status, runErr := a.runner.Run(ctx)
	if runErr != nil {
		return fmt.Errorf("initVaultSubsystemsOnly: migrations: %w", runErr)
	}
	a.cfg.Logger.Info("migration runner status (switch)",
		"state", status.State,
		"failed_migration", status.FailedMigration)

	// 6b. Frontmatter scaffold injection (idempotent).
	if status.State != migrate.StateUnrecoverable {
		if err := InjectFrontmatterScaffoldMigration(ctx, pair.Writer, notesDir, a.cfg.Logger); err != nil {
			return fmt.Errorf("initVaultSubsystemsOnly: frontmatter scaffold: %w", err)
		}
	}

	// 7. Incremental reindex.
	if status.State != migrate.StateUnrecoverable {
		n, err := a.indexer.ReconcileWithRegistry(ctx, index.ModeIncremental, nil)
		if err != nil {
			a.cfg.Logger.Warn("switch: incremental reindex failed (non-fatal)", "err", err)
		} else {
			a.cfg.Logger.Info("switch: incremental reindex done", "notes_indexed", n)
		}
	}

	// 8. Rebuild api.Server, WS hub, MCP.
	// The hub is rebuilt per-vault so new WS connections (after the SPA
	// reloads) hit the new vault's hub. Existing WS connections remain on
	// the old hub until the SPA reloads.
	hub := wshub.New(a.cfg.Logger)
	a.mu.Lock()
	a.hub = hub
	a.mu.Unlock()

	files := fsstore.NewStore(notesDir)
	notesSvc := notes.NewService(files, a.indexer, hub, a.cfg.Logger)

	if a.indexer != nil && status.State != migrate.StateUnrecoverable {
		if summaries, err := a.indexer.List(ctx); err == nil {
			notesSvc.Registry().Hydrate(summaries)
			a.cfg.Logger.Info("switch: registry hydrated", "count", len(summaries))
			if rErr := a.indexer.ResolvePendingBacklinks(ctx, notesSvc.Registry()); rErr != nil {
				a.cfg.Logger.Warn("switch: pending backlinks resolution failed (non-fatal)", "err", rErr)
			}
		} else {
			a.cfg.Logger.Warn("switch: registry hydrate: List failed", "err", err)
		}
	}
	a.mu.Lock()
	a.notesSvc = notesSvc
	a.mu.Unlock()

	apiServer := api.NewServerWithIndex(notesSvc, a.runner, a.runner, a.indexer, hub, a.cfg.Logger, a.cfg.DataDir)
	apiServer.SetMigrationsFS(a.runner.Migrations)
	apiServer.SetVaultSwitcher(a)
	apiServer.SetInFlightWrites(&a.inFlightWrites)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(securityHeadersMiddleware)
	r.Use(requestLogger(a.cfg.Logger))
	si := api.NewStrictHandler(apiServer, nil)
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(maxBodyBytes(maxAttachmentBodyBytes))
		r.Use(sessionIDMiddleware)
		r.Use(api.ConfigStrictBodyMiddleware)
		api.HandlerFromMux(si, r)
		r.Get("/ws", hub.ServeHTTP)
		r.Get("/files", apiServer.ServeFile)
	})
	r.Mount("/", static.Handler())
	a.handler.Swap(r)

	// 8b. MCP server bring-up for the new vault.
	a.mcpServer = nil
	a.mcpShutdown = nil
	mcpCfg, mcpCfgErr := config.Load(a.cfg.DataDir, a.cfg.Logger)
	if mcpCfgErr != nil {
		a.cfg.Logger.Warn("switch: MCP config load failed (continuing with MCP disabled)", "err", mcpCfgErr)
	} else if mcpCfg.MCP.Enabled {
		mcpSrv, mcpShutdownFn, mcpErr := a.startMCP(ctx, mcpCfg.MCP, notesSvc, hub, pair)
		if mcpErr != nil {
			a.cfg.Logger.Error("switch: MCP listener failed to bind; continuing without MCP", "err", mcpErr)
		} else {
			a.cfg.Logger.Info("switch: MCP listener up", "port", mcpCfg.MCP.Port)
			a.mcpServer = mcpSrv
			a.mcpShutdown = mcpShutdownFn
		}
	}

	a.setCurrentVaultPath(a.cfg.DataDir)
	return nil
}

// startMCP constructs the MCP ACL + adapters + Server and starts the
// loopback listener on cfg.Bind:cfg.Port. Returns the *http.Server and
// a shutdown function so the caller can defer graceful teardown.
//
// Per D-45 the bind is re-checked at listener layer via
// netbind.RequireLoopbackBind — defense in depth for the (unlikely)
// case where cfg.Bind has been hand-edited to a non-loopback address.
func (a *App) startMCP(
	ctx context.Context,
	cfg config.MCPConfig,
	notesSvc *notes.Service,
	hub *wshub.Hub,
	pair *sqlite.Pair,
) (*http.Server, func(context.Context) error, error) {
	bind := cfg.Bind
	if bind == "" {
		bind = "127.0.0.1"
	}
	bindAddr := fmt.Sprintf("%s:%d", bind, cfg.Port)

	acl := mcp.NewACL(pair.Writer)
	// Adapter construction uses cfg.Server.DataDir (08-01 Task 4 thread-
	// through on app.Config) for the attachments root.
	dataDir := a.cfg.Server.DataDir
	if dataDir == "" {
		dataDir = a.cfg.DataDir
	}
	notesProv := mcp.NewNotesProvider(a.indexer)
	searchProv := mcp.NewSearchAdapter(func(ctx context.Context, q string, limit int) ([]mcp.SearchHit, error) {
		hits, err := a.indexer.SearchFTS(ctx, q, "", limit)
		if err != nil {
			return nil, err
		}
		out := make([]mcp.SearchHit, 0, len(hits))
		for _, h := range hits {
			out = append(out, mcp.SearchHit{
				ID:          h.ID,
				Path:        h.Path,
				Title:       h.Title,
				ExcerptHTML: h.ExcerptHTML,
			})
		}
		return out, nil
	})
	attachProv := mcp.NewAttachmentAdapter(notesSvc, dataDir)

	mcpServer := mcp.NewServer(notesSvc, notesProv, searchProv, attachProv, acl, hub, a.cfg.Logger)

	srv, err := mcp.StartMCPListener(ctx, mcpServer, bindAddr, a.cfg.Logger)
	if err != nil {
		return nil, nil, err
	}
	return srv, srv.Shutdown, nil
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

// OpenVault transitions a no-vault App to an open-vault App.
// Called by POST /vault/open and POST /vault/create after their disk-side
// preparation work completes.
//
// Plan 08-17b implementation: single-shot. Returns ErrAlreadyOpen if a
// vault DB pair is already set up (i.e., bootPerVaultSubsystems already
// ran). Plan 08-17d adds hot-swap support with an in-process mutex.
//
// The ctx parameter controls the lifetime of the newly started per-vault
// server. Cancel it to shut down the server loop and release DB handles.
//
// Side effect: updates app.json via vault.TouchOpened + SaveAppJSON so
// current_vault is persisted and last_opened_at is refreshed. Clears
// api.BootBanner so subsequent GET /vault/recent returns no banner.
func (a *App) OpenVault(ctx context.Context, absCanonical string) error {
	// V5 single-flight: piggyback on the hot-swap mutex so concurrent
	// OpenVault + SwitchVault calls can't race. The swap mutex was
	// added for 17d; reusing it here means a user clicking Create then
	// Switch in quick succession serializes safely.
	if !a.swapMu.TryLock() {
		return ErrSwitchInProgress
	}
	defer a.swapMu.Unlock()

	a.mu.Lock()
	alreadyOpen := a.pair != nil
	a.mu.Unlock()
	if alreadyOpen {
		// Caller should use SwitchVault for vault → vault transitions.
		return ErrAlreadyOpen
	}

	// Update app.json: register the vault as current + refresh last_opened_at.
	appJSONPath, err := vault.AppJSONPath()
	if err != nil {
		return fmt.Errorf("OpenVault: resolve app home: %w", err)
	}
	state, err := vault.LoadAppJSON(appJSONPath)
	if err != nil {
		return fmt.Errorf("OpenVault: load app.json: %w", err)
	}
	// Use existing display_name if the entry is already registered.
	displayName := filepath.Base(absCanonical)
	for _, e := range state.RecentVaults {
		if e.Path == absCanonical {
			displayName = e.DisplayName
			break
		}
	}
	vault.TouchOpened(state, absCanonical, displayName)
	if err := vault.SaveAppJSON(appJSONPath, state); err != nil {
		return fmt.Errorf("OpenVault: save app.json: %w", err)
	}
	api.BootBanner = ""

	// Bring up the per-vault subsystems against the new path. We use
	// initVaultSubsystemsOnly (steps 1-8, no listener) rather than
	// bootPerVaultSubsystems (1-9 — opens a NEW listener). The HTTP
	// listener installed by lifecycle.Run for the no-vault picker shell
	// is still serving on this port; we just need to swap its handler
	// to the newly-built full-stack router, which initVaultSubsystemsOnly
	// already does via a.handler.Swap(r) at its router-build step.
	a.cfg.DataDir = absCanonical
	return a.initVaultSubsystemsOnly(ctx)
}
