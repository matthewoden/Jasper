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
	"github.com/matthewoden/jasper/backend/internal/firstrun"
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
// Hot-swap is not yet supported.
var ErrAlreadyOpen = errors.New("a vault is already open; hot-swap not yet supported (see 08-17d)")

func notesDirFor(dataDir string) string { return filepath.Join(dataDir, "notes") }

// EnsureDataDir creates <dataDir>/{notes,.jasper} with 0o755 perms if
// missing. 0o755 (not 0o700) because Jasper runs as the user and that
// permission matches the prevailing convention for app-data dirs on
// macOS/Linux. A more restrictive 0o700 would surprise sync tools
// (Syncthing, iCloud, git) that need to walk the tree.
func EnsureDataDir(dataDir string) error {
	for _, sub := range []string{"notes", vault.SubdirName} {
		if err := os.MkdirAll(filepath.Join(dataDir, sub), 0o755); err != nil {
			return fmt.Errorf("ensure %s: %w", sub, err)
		}
	}
	return nil
}

// SeedScratchpadIfMissing writes notes.ScratchpadWelcome to
// <dataDir>/notes/scratchpad.md only if the file does not already exist.
// Idempotent — safe to call on every startup. Uses fsstore.AtomicWrite
// so every byte goes through temp+fsync+rename+fsync(parent).
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

func (a *App) serveStartupError(ctx context.Context, phaseName string, initErr error) error {
	logsPath := vault.LogsPath(a.cfg.DataDir)
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

// Run executes the startup sequence and serves until ctx is canceled.
// On ctx cancellation a graceful shutdown is attempted with a 5-second
// deadline.
//
// Boot steps:
//
//  0. resolveVaultMode — read app.json; determine modeOpen vs modeNoVault.
//     Per-vault subsystems remain dormant in no-vault mode.
//
// Per-vault steps (only when modeOpen):
//
//  1. EnsureDataDir — mkdir <DataDir>/{notes,.jasper}.
//  2. SeedScratchpadIfMissing — write the welcome template if absent.
//  3. mkdir <DataDir>/.jasper and <DataDir>/.jasper/logs (migration
//     runner expects them).
//  4. sqlite.Open — open the writer/reader Pair on app.db.
//     pair.Close is always safe even if the runner returned an error.
//  5. Build *index.Indexer + *migrate.Runner; wire Path2Rebuild.
//  6. runner.Run — apply pending migrations. Three outcomes:
//     - StateOK / StateRolledBack → continue to step 7.
//     - ErrDiskFull → install the disk-full static handler.
//     - ErrUnrecoverable → install the unrecoverable static handler.
//  7. indexer.Reconcile(ModeIncremental) — startup delta scan.
//     Only runs when state != Unrecoverable.
//  8. Rebuild api.Server with full wiring and replace a.handler.
//  9. net.Listen + http.Server.Serve, graceful shutdown on ctx.Done.
//
// ReadHeaderTimeout is set to mitigate slowloris-style attacks.
func (a *App) Run(ctx context.Context) error {
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
		if a.cfg.DataDir != "" && banner == "" {
			a.cfg.Logger.Info("jasper boot: legacy DataDir fallback (pre-vault-model wiring)",
				"data_dir", a.cfg.DataDir)
			return a.bootPerVaultSubsystems(ctx)
		}

		if a.cfg.Logger == nil {
			a.cfg.Logger = slog.Default()
		}
		a.cfg.Logger.Info("jasper boot: no vault selected, serving picker shell")
		return a.serveListener(ctx)
	}

	a.cfg.DataDir = openPath
	return a.bootPerVaultSubsystems(ctx)
}

func (a *App) bootPerVaultSubsystems(ctx context.Context) error {
	if err := EnsureDataDir(a.cfg.DataDir); err != nil {
		return a.serveStartupError(ctx, "Data dir", err)
	}

	if a.cfg.Logger == nil {
		logger, closer, err := jlog.NewFileLogger(a.cfg.Server.DataDir)
		if err != nil {
			return a.serveStartupError(ctx, "File logger", fmt.Errorf("file logger init: %w", err))
		}
		a.cfg.Logger = logger
		a.fileLogCloser = closer
		defer func() {
			if cerr := closer.Close(); cerr != nil {
				fmt.Fprintf(os.Stderr, "file logger close: %v\n", cerr)
			}
		}()
	}

	if err := SeedScratchpadIfMissing(a.cfg.DataDir, a.cfg.Logger); err != nil {
		return a.serveStartupError(ctx, "Scratchpad seed", err)
	}

	dbPath := vault.AppDBPath(a.cfg.DataDir)
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return a.serveStartupError(ctx, "Storage dir", fmt.Errorf("ensure .jasper dir: %w", err))
	}
	logsDir := vault.LogsDir(a.cfg.DataDir)
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return a.serveStartupError(ctx, "Logs dir", fmt.Errorf("ensure logs dir: %w", err))
	}

	backupPath := vault.BackupPath(a.cfg.DataDir)
	logsPath := vault.LogsPath(a.cfg.DataDir)

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

	defer func() { _ = pair.Close() }()
	a.pair = pair

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

	status, runErr := a.runner.Run(ctx)
	if runErr != nil {
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

	if status.State != migrate.StateUnrecoverable {
		if err := InjectFrontmatterScaffoldMigration(ctx, pair.Writer, notesDir, a.cfg.Logger); err != nil {
			return a.serveStartupError(ctx, "Frontmatter scaffold", fmt.Errorf("lifecycle: frontmatter scaffold migration: %w", err))
		}
	}

	if status.State != migrate.StateUnrecoverable {
		// Drain any seed grants queued by firstrun.RunSetup. Non-fatal: a
		// corrupt seed_grants.json should not brick boot; ON CONFLICT DO
		// UPDATE makes a repeat-apply safe.
		if err := firstrun.ApplySeedGrants(ctx, pair.Writer, a.cfg.DataDir); err != nil {
			a.cfg.Logger.Warn("apply seed grants failed (non-fatal)", "err", err)
		}
	}

	if status.State != migrate.StateUnrecoverable {
		n, err := a.indexer.ReconcileWithRegistry(ctx, index.ModeIncremental, nil)
		if err != nil {
			a.cfg.Logger.Warn("startup incremental reindex failed (non-fatal)", "err", err)
		} else {
			a.cfg.Logger.Info("startup incremental reindex done", "notes_indexed", n)
		}
	}

	hub := wshub.New(a.cfg.Logger, a.cfg.ListenAddr)
	a.mu.Lock()
	a.hub = hub
	a.mu.Unlock()

	files := fsstore.NewStore(notesDir)
	notesSvc := notes.NewService(files, a.indexer, hub, a.cfg.Logger)

	if a.indexer != nil && status.State != migrate.StateUnrecoverable {
		if summaries, err := a.indexer.List(ctx); err == nil {
			notesSvc.Registry().Hydrate(summaries)
			a.cfg.Logger.Info("registry hydrated", "count", len(summaries))

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
		r.Use(csrfOriginMiddleware(a.cfg.ListenAddr))
		api.HandlerFromMux(si, r)

		r.Get("/ws", hub.ServeHTTP)

		r.Get("/files", apiServer.ServeFile)
	})
	r.Mount("/", static.Handler())
	a.handler.Swap(r)

	mcpCfg, mcpCfgErr := config.Load(a.cfg.DataDir, a.cfg.Logger)
	if mcpCfgErr != nil {
		a.cfg.Logger.Warn("MCP: config load failed (continuing with MCP disabled)", "err", mcpCfgErr)
	} else if mcpCfg.MCP.Enabled {
		mcpSrv, mcpShutdownFn, acl, mcpErr := a.startMCP(ctx, mcpCfg.MCP, notesSvc, hub, pair)
		if mcpErr != nil {
			a.cfg.Logger.Error("MCP listener failed to bind; continuing without MCP", "err", mcpErr)
		} else {
			a.cfg.Logger.Info("MCP listener up", "port", mcpCfg.MCP.Port, "bind", mcpCfg.MCP.Bind)

			a.mcpServer = mcpSrv
			a.mcpShutdown = mcpShutdownFn

			apiServer.SetMcpACL(acl)
		}
	}

	a.setCurrentVaultPath(a.cfg.DataDir)

	defer func() {
		if a.mcpShutdown != nil {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := a.mcpShutdown(shutdownCtx); err != nil {
				a.cfg.Logger.Warn("MCP listener shutdown error", "err", err)
			}
			a.mcpShutdown = nil
		}

		if a.pair != nil && a.pair != pair {
			_ = a.pair.Close()
		}
	}()
	return a.serveListener(ctx)
}

func (a *App) initVaultSubsystemsOnly(ctx context.Context) error {
	if err := EnsureDataDir(a.cfg.DataDir); err != nil {
		return fmt.Errorf("initVaultSubsystemsOnly: data dir: %w", err)
	}

	if a.cfg.Logger == nil {
		a.cfg.Logger = slog.Default()
	}

	if err := SeedScratchpadIfMissing(a.cfg.DataDir, a.cfg.Logger); err != nil {
		return fmt.Errorf("initVaultSubsystemsOnly: scratchpad seed: %w", err)
	}

	dbPath := vault.AppDBPath(a.cfg.DataDir)
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return fmt.Errorf("initVaultSubsystemsOnly: .jasper dir: %w", err)
	}
	logsDir := vault.LogsDir(a.cfg.DataDir)
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return fmt.Errorf("initVaultSubsystemsOnly: logs dir: %w", err)
	}

	backupPath := vault.BackupPath(a.cfg.DataDir)
	logsPath := vault.LogsPath(a.cfg.DataDir)

	if err := migrate.PreflightFreeSpace(dbPath); err != nil {
		return fmt.Errorf("initVaultSubsystemsOnly: disk preflight: %w", err)
	}

	pair, err := sqlite.Open(ctx, dbPath)
	if err != nil {
		return fmt.Errorf("initVaultSubsystemsOnly: sqlite open: %w", err)
	}

	a.pair = pair

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

	status, runErr := a.runner.Run(ctx)
	if runErr != nil {
		return fmt.Errorf("initVaultSubsystemsOnly: migrations: %w", runErr)
	}
	a.cfg.Logger.Info("migration runner status (switch)",
		"state", status.State,
		"failed_migration", status.FailedMigration)

	if status.State != migrate.StateUnrecoverable {
		if err := InjectFrontmatterScaffoldMigration(ctx, pair.Writer, notesDir, a.cfg.Logger); err != nil {
			return fmt.Errorf("initVaultSubsystemsOnly: frontmatter scaffold: %w", err)
		}
	}

	if status.State != migrate.StateUnrecoverable {
		// Mirror of bootPerVaultSubsystems: drain seed grants on hot-swap
		// into a freshly-created vault. Non-fatal on error.
		if err := firstrun.ApplySeedGrants(ctx, pair.Writer, a.cfg.DataDir); err != nil {
			a.cfg.Logger.Warn("switch: apply seed grants failed (non-fatal)", "err", err)
		}
	}

	if status.State != migrate.StateUnrecoverable {
		n, err := a.indexer.ReconcileWithRegistry(ctx, index.ModeIncremental, nil)
		if err != nil {
			a.cfg.Logger.Warn("switch: incremental reindex failed (non-fatal)", "err", err)
		} else {
			a.cfg.Logger.Info("switch: incremental reindex done", "notes_indexed", n)
		}
	}

	hub := wshub.New(a.cfg.Logger, a.cfg.ListenAddr)
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
		r.Use(csrfOriginMiddleware(a.cfg.ListenAddr))
		api.HandlerFromMux(si, r)
		r.Get("/ws", hub.ServeHTTP)
		r.Get("/files", apiServer.ServeFile)
	})
	r.Mount("/", static.Handler())

	a.mcpServer = nil
	a.mcpShutdown = nil
	mcpCfg, mcpCfgErr := config.Load(a.cfg.DataDir, a.cfg.Logger)
	if mcpCfgErr != nil {
		a.cfg.Logger.Warn("switch: MCP config load failed (continuing with MCP disabled)", "err", mcpCfgErr)
	} else if mcpCfg.MCP.Enabled {
		mcpSrv, mcpShutdownFn, acl, mcpErr := a.startMCP(ctx, mcpCfg.MCP, notesSvc, hub, pair)
		if mcpErr != nil {
			a.cfg.Logger.Error("switch: MCP listener failed to bind; continuing without MCP", "err", mcpErr)
		} else {
			a.cfg.Logger.Info("switch: MCP listener up", "port", mcpCfg.MCP.Port)
			a.mcpServer = mcpSrv
			a.mcpShutdown = mcpShutdownFn

			// SetMcpACL must be called before a.handler.Swap(r) so the first
			// non-503 response to GET /api/v1/mcp/grants always reflects vault
			// B's fully-initialised ACL. Any earlier swap would create a window
			// where mcpACL==nil and GET returns 200 with an empty grant list,
			// causing clients to POST grants against the wrong (nil) ACL.
			apiServer.SetMcpACL(acl)
		}
	}

	// Swap the handler only after all vault-B subsystems (including MCP ACL)
	// are wired. Requests during the 503 window (handler==nil) retry until
	// this swap completes, ensuring the first 200 is fully coherent.
	a.handler.Swap(r)

	a.setCurrentVaultPath(a.cfg.DataDir)
	return nil
}

func (a *App) startMCP(
	ctx context.Context,
	cfg config.MCPConfig,
	notesSvc *notes.Service,
	hub *wshub.Hub,
	pair *sqlite.Pair,
) (*http.Server, func(context.Context) error, *mcp.ACL, error) {
	bind := cfg.Bind
	if bind == "" {
		bind = "127.0.0.1"
	}
	bindAddr := fmt.Sprintf("%s:%d", bind, cfg.Port)

	acl := mcp.NewACL(pair.Writer)

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
		return nil, nil, nil, err
	}
	return srv, srv.Shutdown, acl, nil
}

func (a *App) serveListener(ctx context.Context) error {
	srv := &http.Server{
		Addr:              a.cfg.ListenAddr,
		Handler:           a.handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	var (
		ln  net.Listener
		err error
	)
	if a.cfg.ListenerOverride != nil {
		ln = a.cfg.ListenerOverride
	} else {
		ln, err = net.Listen("tcp", a.cfg.ListenAddr)
		if err != nil {
			return fmt.Errorf("listen %s: %w", a.cfg.ListenAddr, err)
		}
	}
	a.cfg.Logger.Info("jasper listening", "addr", ln.Addr().String(), "data_dir", a.cfg.DataDir)

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

// OpenVault transitions a no-vault App to an open-vault App. Called by
// POST /vault/open and POST /vault/create after disk-side preparation.
// Returns ErrAlreadyOpen if a vault DB pair is already set up. ctx
// controls the lifetime of the per-vault subsystems; cancel it to shut
// down and release DB handles. Updates app.json so current_vault is
// persisted and clears api.BootBanner.
func (a *App) OpenVault(ctx context.Context, absCanonical string) error {
	if !a.swapMu.TryLock() {
		return ErrSwitchInProgress
	}
	defer a.swapMu.Unlock()

	a.mu.Lock()
	alreadyOpen := a.pair != nil
	a.mu.Unlock()
	if alreadyOpen {
		return ErrAlreadyOpen
	}

	appJSONPath, err := vault.AppJSONPath()
	if err != nil {
		return fmt.Errorf("OpenVault: resolve app home: %w", err)
	}
	state, err := vault.LoadAppJSON(appJSONPath)
	if err != nil {
		return fmt.Errorf("OpenVault: load app.json: %w", err)
	}

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

	a.cfg.DataDir = absCanonical
	return a.initVaultSubsystemsOnly(ctx)
}
