// Package app is the composition root. It wires concrete adapters
// (fsstore.Store) → ports (notes.FileStore) → service (notes.Service)
// → API (api.Server + StrictHandler) → router (chi) → SPA fallback
// (static.Handler).
//
// chi mount order is FIRST API under r.Route("/api/v1", ...) and LAST
// the SPA fallback (Pitfall 13). Plan 02's handler tests use the same
// r.Route("/api/v1", ...) wrapper so dev tests and the production
// binary serve identical URLs.
//
// Phase 2 boundary: New() builds a Phase-1-compatible router with the
// API server in nil-everything mode (no migration runner, no SQLite
// pair, no real indexer). The REAL composition (sqlite.Open →
// migrate.NewRunner → index.New → api.NewServerWithIndex) happens in
// lifecycle.Run because it is side-effecting (mkdir + open DB) and
// must run BEFORE the HTTP listener accepts connections (DESIGN.md
// §6.1). Run replaces a.handler with the fully-wired router after
// migrations + incremental reindex complete.
package app

import (
	"context"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"sync/atomic"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/matthewoden/jasper/backend/internal/api"
	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/db/migrate"
	"github.com/matthewoden/jasper/backend/internal/db/sqlite"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/internal/static"
	"github.com/matthewoden/jasper/backend/internal/wshub"
	"github.com/matthewoden/jasper/backend/migrations"
)

// Config is the resolved runtime configuration for `jasper serve`.
// cmd/jasper/serve.go populates this after applying the
// flag → env → default precedence chain (D-07).
type Config struct {
	// DataDir is the resolved absolute path under which <DataDir>/notes/
	// holds .md files and <DataDir>/storage/ holds Phase 2's SQLite
	// database (app.db) and logs. Caller passes an absolute path;
	// lifecycle.go creates the subdirs on Run.
	//
	// LEGACY (pre-Phase-8): this top-level field is retained for
	// backward compat with existing lifecycle.go references
	// (a.cfg.DataDir). New code paths SHOULD prefer cfg.Server.DataDir
	// (forward-looking — Phase 8 D-04 wizard wires it).
	// Both carry the same value (set at app init by cmd/jasper/serve.go).
	DataDir string

	// Server mirrors the loaded config.Config.Server block. Set at app
	// init from the config.Load result. Makes cfg.Server.DataDir
	// reachable in downstream middleware (Plan 08-02 firstrun) and
	// the FileLogger (Plan 08-12) without those code paths having to
	// re-load config.json or thread an additional argument.
	//
	// Phase 8 Plan 08-01 Task 4 thread-through: declared here so
	// downstream waves compile cleanly. cmd/jasper/serve.go (or the
	// equivalent app-init caller in 08-02) populates the value before
	// calling app.New. While the field is zero-valued, downstream
	// readers may fall back to cfg.DataDir.
	Server config.ServerConfig

	// ListenAddr is the host:port to bind. Phase 1 enforces loopback
	// at the CLI layer (see cmd/jasper/serve.go's call to
	// netbind.RequireLoopbackBind, Plan 08-01 Task 3).
	ListenAddr string

	// Logger is the structured logger used by middleware and lifecycle.
	// Must be non-nil; cmd/jasper/serve.go passes slog.New(...).
	Logger *slog.Logger

	// MigrationsOverride is a TEST-ONLY override for the embedded
	// migrations FS. When non-nil, lifecycle.Run uses this fs.FS
	// instead of migrations.FS. Production callers leave it nil.
	//
	// Used by:
	//   - app_test.go (TestApp_Run_BrokenMigration_FiresPath1) to
	//     inject a deliberately broken 002_break.sql
	//   - cmd/jasper/smoke_test.go via JASPER_TEST_MIGRATIONS_DIR
	//     env var (cmd/jasper/serve.go reads the env var and sets
	//     this field to os.DirFS(<dir>) before calling app.New).
	MigrationsOverride fs.FS

	// DisableFirstRunGate is a TEST-ONLY flag retained for backward
	// compatibility. As of Plan 08-17b the firstrun.RedirectMiddleware
	// is no longer mounted on the live router (the vault-model lifecycle
	// branch handles the no-vault state). This field is now a no-op;
	// it is kept so existing test code that sets it continues to compile.
	DisableFirstRunGate bool

	// VaultOverride is the canonical path supplied via --vault (cobra flag,
	// added in Plan 08-17a). Empty when no override is given.
	// resolveVaultMode consults this BEFORE consulting app.json's
	// current_vault. Set by cmd/jasper/serve.go after canonicalizing the
	// flag value.
	VaultOverride string

	// ListenerOverride is a TEST-ONLY pre-bound listener. When non-nil,
	// lifecycle.serveListener uses it directly instead of calling
	// net.Listen(ListenAddr). Eliminates the TOCTOU race in test helpers
	// that pick a free port by binding, reading addr, and closing — the
	// OS may hand the same "free" port to another caller before the SUT
	// rebinds. Production callers leave it nil.
	ListenerOverride net.Listener
}

// App bundles the wired application. New constructs Phase-1-shape
// dependencies and returns the composed *App; Run executes the Phase 2
// startup sequence (sqlite + migrate + reindex) and serves until ctx
// is canceled.
//
// pair, runner, and indexer are populated by lifecycle.Run, NOT by
// New. They are nil between New and Run so Phase 1 tests that call
// New + Handler() directly continue to work unchanged.
//
// diskFullHandler is non-nil ONLY when boot fails (ErrDiskFull or
// ErrUnrecoverable). When non-nil, lifecycle.Run installs it as
// a.handler and serves it on the listener instead of the API + SPA.
type App struct {
	cfg Config

	handler *swappableHandler

	pair    *sqlite.Pair
	runner  *migrate.Runner
	indexer *index.Indexer

	mu       sync.RWMutex
	notesSvc *notes.Service

	hub *wshub.Hub

	diskFullHandler http.Handler

	fileLogCloser io.Closer

	swapMu sync.Mutex

	inFlightWrites sync.WaitGroup

	currentVaultPath atomic.Pointer[string]

	mcpServer *http.Server

	mcpShutdown func(ctx context.Context) error
}

func storageDBPath(dataDir string) string {
	return filepath.Join(dataDir, "storage", "app.db")
}

// New builds a Phase-1-compatible composition for `jasper serve`. The
// real Phase 2 wiring (sqlite.Open → migrate.NewRunner → index.New →
// api.NewServerWithIndex) lives in lifecycle.Run because it is side-
// effecting (mkdir + open DB) and must run BEFORE the listener accepts
// connections (DESIGN.md §6.1).
//
// Wiring sequence (Phase-1-shape — kept here for backward compatibility
// with app_test.go's httptest.NewServer(a.Handler()) pattern):
//
//  1. fsstore.NewStore(<DataDir>/notes) — concrete FileStore adapter.
//  2. notes.NewService(files, nil, log) — domain service with nil
//     Index (Service substitutes nopIndex). Phase 2 lifecycle.Run
//     replaces this with a real *index.Indexer-backed Service.
//  3. api.NewServer(notesSvc, log) — 2-arg constructor; internally
//     delegates to NewServerWithIndex with nil status/runner/index
//     so handlers gracefully degrade.
//  4. chi router with RequestID + Recoverer + requestLogger.
//  5. r.Route("/api/v1", ...) wrapping api.HandlerFromMux — Pitfall
//     13 mount.
//  6. r.Mount("/", static.Handler()) — SPA fallback LAST.
func New(cfg Config) (*App, error) {
	notesDir := notesDirFor(cfg.DataDir)
	files := fsstore.NewStore(notesDir)

	notesSvc := notes.NewService(files, nil, nil, cfg.Logger)
	apiServer := api.NewServerWithIndex(notesSvc, nil, nil, nil, nil, cfg.Logger, cfg.DataDir)

	var migrationsFS fs.FS = migrations.FS
	if cfg.MigrationsOverride != nil {
		migrationsFS = cfg.MigrationsOverride
	}
	apiServer.SetMigrationsFS(migrationsFS)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(securityHeadersMiddleware)

	r.Use(requestLogger(cfg.Logger))

	si := api.NewStrictHandler(apiServer, nil)
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(maxBodyBytes(maxAttachmentBodyBytes))
		r.Use(api.ConfigStrictBodyMiddleware)
		api.HandlerFromMux(si, r)

		r.Get("/files", apiServer.ServeFile)
	})

	r.Mount("/", static.Handler())

	a := &App{cfg: cfg, handler: newSwappableHandler(r)}

	apiServer.SetVaultOpener(a)
	return a, nil
}

// Handler returns the composed http.Handler for the app — useful
// for httptest in unit tests. The returned handler is the swappable
// wrapper; ServeHTTP delegates to whatever router is currently
// installed (initial Phase-1 router → no-vault picker shell → per-vault
// full stack as the app transitions).
func (a *App) Handler() http.Handler { return a.handler }

// Config returns the resolved configuration the app was built with.
func (a *App) Config() Config { return a.cfg }

// CurrentVaultPath returns the canonical path of the currently open vault.
// Returns an empty string when no vault is open. Safe for concurrent callers.
func (a *App) CurrentVaultPath() string {
	if p := a.currentVaultPath.Load(); p != nil {
		return *p
	}
	return ""
}

func (a *App) setCurrentVaultPath(p string) {
	a.currentVaultPath.Store(&p)
}

// NotesService returns the wired *notes.Service. Returns nil if Run
// has not yet executed step 8 (or if Run took the disk-full /
// unrecoverable error path which never builds the notes service).
//
// Plan 03-04 introduces this accessor for app_test.go's
// TestRun_HydrateRegistry — it lets the test assert that the registry
// was populated from indexer.List before the listener accepted
// connections (T-03-04-07). Access is synchronized via a.mu to
// satisfy the Go memory model when called from a different goroutine
// than the one running Run.
func (a *App) NotesService() *notes.Service {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.notesSvc
}
