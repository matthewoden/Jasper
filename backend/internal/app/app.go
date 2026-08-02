// Package app is the composition root.
//
// chi mount order matters: API first, SPA fallback LAST — otherwise the
// fallback swallows API 404s.
package app

import (
	"context"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"strings"
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
	"github.com/matthewoden/jasper/backend/internal/netbind"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/internal/static"
	"github.com/matthewoden/jasper/backend/internal/wshub"
	"github.com/matthewoden/jasper/backend/migrations"
)

// Config is the resolved runtime configuration for `jasper serve`.
// cmd/jasper/serve.go populates this after applying the
// flag → env → default precedence chain.
type Config struct {
	// DataDir is the resolved absolute path under which <DataDir>/notes/
	// holds .md files and <DataDir>/.jasper/ holds the SQLite database
	// (app.db) and logs. Caller passes an absolute path; lifecycle.go
	// creates the subdirs on Run.
	//
	// This is the field to read. Server.DataDir looks like a synonym and is
	// not: it is whatever the CLI resolved before the vault was known, so it
	// is empty for a bare `jasper serve`, while Run sets this one to the
	// vault actually opened.
	DataDir string

	// Server mirrors the loaded config.Config.Server block. Set at app
	// init from the config.Load result. While zero-valued, downstream
	// readers may fall back to cfg.DataDir.
	Server config.ServerConfig

	// ListenAddr is the host:port to bind. Loopback is enforced at the
	// CLI layer via netbind.RequireLoopbackBind.
	ListenAddr string

	// Logger is the *console* logger used by middleware and lifecycle;
	// cmd/jasper/serve.go passes a stderr slog.New(...). New falls back to
	// slog.Default() when nil, and rewraps it so that opening a vault adds
	// that vault's log file alongside the console handler.
	Logger *slog.Logger

	// MigrationsOverride is TEST-ONLY; production callers leave it nil.
	MigrationsOverride fs.FS

	// DisableFirstRunGate is a TEST-ONLY flag retained for backward
	// compatibility. The firstrun.RedirectMiddleware is no longer mounted
	// on the live router; this field is now a no-op kept so existing test
	// code that sets it continues to compile.
	DisableFirstRunGate bool

	// VaultOverride is the canonical path supplied via --vault. Empty when
	// no override is given. resolveVaultMode consults this before
	// consulting app.json's current_vault.
	VaultOverride string

	// ListenerOverride is a TEST-ONLY pre-bound listener. When non-nil,
	// lifecycle.serveListener uses it directly instead of calling
	// net.Listen(ListenAddr). Eliminates the TOCTOU race in test helpers
	// that pick a free port by binding, reading addr, and closing — the
	// OS may hand the same "free" port to another caller before the SUT
	// rebinds. Production callers leave it nil.
	ListenerOverride net.Listener
}

// App bundles the wired application.
//
// pair, runner and indexer are nil between New and Run, so tests may call
// New + Handler() directly. diskFullHandler is non-nil only when boot failed,
// and then replaces the API + SPA on the listener.
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

	// consoleHandler is cfg.Logger's handler as supplied by the caller;
	// vaultLog routes cfg.Logger to it plus the open vault's log file.
	consoleHandler slog.Handler
	vaultLog       *vaultLogHandler
	fileLogCloser  io.Closer

	swapMu sync.Mutex

	inFlightWrites sync.WaitGroup

	currentVaultPath atomic.Pointer[string]

	mcpServer *http.Server

	mcpShutdown func(ctx context.Context) error

	mcpStatus McpStatus
}

// McpStatus reports whether the MCP listener is currently bound. Up is
// false with a human-readable Reason (e.g. "port 6684 in use") when the
// bind attempt failed; the HTTP server still boots and serves the editor
// regardless — this is purely informational for the admin/status
// surface and the frontend's dismissible banner.
type McpStatus struct {
	Up     bool
	Reason string
}

// McpStatus returns the current MCP listener status. Safe for concurrent
// callers; synchronized via a.mu the same way NotesService is.
func (a *App) McpStatus() (up bool, reason string) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.mcpStatus.Up, a.mcpStatus.Reason
}

// allowedOrigins derives the full-URL Origin values permitted by the CSRF
// middleware from the resolved listen address. Stores http://host:port forms
// so comparison against r.Header.Get("Origin") needs no scheme-stripping.
// For 0.0.0.0 binds the returned slice contains loopback forms only;
// csrfOriginMiddleware applies an additional port-match fallback for that case.
func allowedOrigins(listenAddr string) []string {
	_, port, err := net.SplitHostPort(listenAddr)
	if err != nil {
		port = "6683"
	}
	origins := make([]string, 0, 3)
	for _, h := range netbind.LoopbackHosts() {
		if strings.Contains(h, ":") {
			h = "[" + h + "]"
		}
		origins = append(origins, "http://"+h+":"+port)
	}
	return origins
}

// New builds the initial composition for `jasper serve`. The real wiring lives
// in lifecycle.Run because it is side-effecting (mkdir + open DB) and must run
// BEFORE the listener accepts connections.
func New(cfg Config) (*App, error) {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	consoleHandler := cfg.Logger.Handler()
	vaultLog := newVaultLogHandler(consoleHandler)
	cfg.Logger = slog.New(vaultLog)

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
	r.Use(hostAllowlistMiddleware(cfg.ListenAddr))

	si := api.NewStrictHandler(apiServer, nil)
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(maxBodyBytes(maxAttachmentBodyBytes))
		r.Use(api.ConfigStrictBodyMiddleware)
		r.Use(csrfOriginMiddleware(cfg.ListenAddr))
		api.HandlerFromMux(si, r)

		r.Get("/files", apiServer.ServeFile)
	})

	r.Mount("/", static.Handler())

	a := &App{
		cfg:            cfg,
		handler:        newSwappableHandler(r),
		consoleHandler: consoleHandler,
		vaultLog:       vaultLog,
	}

	apiServer.SetVaultOpener(a)
	return a, nil
}

// Handler returns the composed http.Handler for the app. The returned
// handler is the swappable wrapper; ServeHTTP delegates to whatever
// router is currently installed (initial router → no-vault picker shell
// → per-vault full stack as the app transitions).
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
// has not yet completed wiring (or took the disk-full / unrecoverable
// error path which never builds the notes service). Access is
// synchronized via a.mu for callers on a different goroutine than Run.
func (a *App) NotesService() *notes.Service {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.notesSvc
}
