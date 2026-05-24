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
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"path/filepath"
	"sync"

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
	cfg     Config
	handler http.Handler

	pair    *sqlite.Pair
	runner  *migrate.Runner
	indexer *index.Indexer

	// notesSvc is populated by lifecycle.Run during Phase 2/3 startup
	// (step 8 — rebuild api.Server with full wiring). Plan 03-04 adds
	// a NotesService() accessor so app_test.go can verify that the
	// composition root hydrated the registry from indexer.List
	// before the listener accepted connections.
	//
	// Access is synchronized via mu — Run writes notesSvc on the
	// goroutine that runs the lifecycle, and the test reads it from
	// the testing goroutine; the network listener boundary is not a
	// Go memory-model happens-before edge, so we must serialize
	// explicitly.
	mu       sync.RWMutex
	notesSvc *notes.Service

	// hub is the WebSocket broadcast hub. Populated by lifecycle.Run
	// step 8 (Phase 4 Plan 04-04). Nil between New and Run. Guarded
	// by mu (same mutex as notesSvc for simplicity).
	hub *wshub.Hub

	// diskFullHandler is the static error page handler installed
	// when migrate.Run returns ErrDiskFull or ErrUnrecoverable.
	// nil during normal operation.
	diskFullHandler http.Handler

	// fileLogCloser is the io.Closer returned by jlog.NewFileLogger when
	// lifecycle.Run instantiates the file logger (production path where
	// cfg.Logger is nil — Plan 08-12 / D-39 / PERF-03). On graceful
	// shutdown the listener path closes this so the JSON log file is
	// fsync'd and the OS handle released. nil when cfg.Logger was
	// provided by the caller (tests).
	fileLogCloser io.Closer
}

// storageDBPath returns <dataDir>/storage/app.db — the canonical
// location of the SQLite derived index. Centralized so app.New,
// lifecycle.Run, and tests agree.
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
	// Phase-1-shape: nil Index → Service substitutes nopIndex.
	// lifecycle.Run rebuilds the Service with a real *index.Indexer
	// after sqlite.Open + migrate.Run succeed.
	notesSvc := notes.NewService(files, nil, nil, cfg.Logger)
	apiServer := api.NewServerWithIndex(notesSvc, nil, nil, nil, nil, cfg.Logger, cfg.DataDir)
	// Plan 08-02: wire the embedded migrations FS into the api.Server
	// so PostSetup (firstrun.RunSetup) can apply migrations against
	// the user-chosen <DataDir>/storage/app.db. The Phase-1-shape
	// server (this one, mounted in New) serves /api/v1/setup* until
	// lifecycle.Run rebuilds the Server in step 8; the wizard runs
	// against the Phase-1 server, so it MUST have migrationsFS wired.
	var migrationsFS fs.FS = migrations.FS
	if cfg.MigrationsOverride != nil {
		migrationsFS = cfg.MigrationsOverride
	}
	apiServer.SetMigrationsFS(migrationsFS)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(securityHeadersMiddleware) // Plan 05-04 — SECURITY-01, SECURITY-04, D-35: BEFORE requestLogger so 500-via-Recoverer responses carry the headers.
	// Plan 08-17b: firstrun.RedirectMiddleware REMOVED. The no-vault
	// lifecycle branch (vaultMode) now gates per-vault subsystems and
	// serves the picker SPA shell directly. No server-side redirect needed.
	// DisableFirstRunGate retained as a no-op field for backward compat.
	r.Use(requestLogger(cfg.Logger))

	// ORDER MATTERS — Pitfall 13.
	si := api.NewStrictHandler(apiServer, nil)
	r.Route("/api/v1", func(r chi.Router) {
		// Body cap: 200 MiB middleware limit (above the handler's 100 MiB LimitReader
		// cap) so that large attachment uploads reach the handler intact and get a
		// proper HTTP 413 response rather than HTTP 500 from MaxBytesReader.
		// The handler (attachments.go) enforces the actual 100 MiB cap via
		// io.LimitReader and returns CreateAttachment413JSONResponse.
		// See maxAttachmentBodyBytes in middleware.go for the full rationale.
		r.Use(maxBodyBytes(maxAttachmentBodyBytes))
		r.Use(api.ConfigStrictBodyMiddleware) // D-40: strict JSON for PUT /config
		api.HandlerFromMux(si, r)
		// Plan 07-38 (UAT-4 R7a): override GET /files with ServeFile so
		// Content-Type is dynamic (image/svg+xml etc.). Same
		// last-registration-wins pattern as /ws in lifecycle.go.
		r.Get("/files", apiServer.ServeFile)
	})

	// SPA fallback LAST.
	r.Mount("/", static.Handler())

	return &App{cfg: cfg, handler: r}, nil
}

// Handler returns the composed http.Handler for the app — useful
// for httptest in unit tests.
func (a *App) Handler() http.Handler { return a.handler }

// Config returns the resolved configuration the app was built with.
func (a *App) Config() Config { return a.cfg }

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
