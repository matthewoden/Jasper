// Package app is the Phase 1 composition root. It wires concrete
// adapters (fsstore.Store) → ports (notes.FileStore) → service
// (notes.Service) → API (api.Server + StrictHandler) → router (chi)
// → SPA fallback (static.Handler).
//
// chi mount order is FIRST API under r.Route("/api/v1", ...) and LAST
// the SPA fallback (Pitfall 13). Plan 02's handler tests use the same
// r.Route("/api/v1", ...) wrapper so dev tests and the production
// binary serve identical URLs.
package app

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/matthewoden/jasper/backend/internal/api"
	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/internal/static"
)

// Config is the resolved runtime configuration for `jasper serve`.
// Plan 04's cmd/jasper/serve.go populates this after applying the
// flag → env → default precedence chain (D-07).
type Config struct {
	// DataDir is the resolved absolute path under which <DataDir>/notes/
	// holds .md files and <DataDir>/storage/ is reserved for Phase 2's
	// SQLite database. Caller passes an absolute path; lifecycle.go
	// creates the subdirs on Run.
	DataDir string

	// ListenAddr is the host:port to bind. Phase 1 enforces loopback
	// at the CLI layer (see cmd/jasper/serve.requireLoopbackBind).
	ListenAddr string

	// Logger is the structured logger used by middleware and lifecycle.
	// Must be non-nil; cmd/jasper/serve.go passes slog.New(...).
	Logger *slog.Logger
}

// App bundles the wired application. New constructs all dependencies
// and returns the composed *App; Run executes the startup sequence and
// serves until ctx is canceled.
type App struct {
	cfg     Config
	handler http.Handler
}

// New builds the composition root. Pure wiring with no side effects
// on disk — startup steps (mkdir + seed scratchpad.md) are in
// lifecycle.go and run from App.Run.
//
// Wiring sequence (locked):
//
//  1. fsstore.NewStore(<DataDir>/notes) — concrete FileStore adapter.
//  2. notes.NewService(files, nil, log) — domain service. The nil
//     Index parameter is the Phase 2 hook point per ports.go.
//  3. api.NewServer(notesSvc, log) — the StrictServerInterface impl.
//  4. chi router with RequestID + Recoverer + requestLogger middleware
//     (RequestID FIRST so requestLogger can include the id).
//  5. r.Route("/api/v1", ...) wrapping api.HandlerFromMux — CRUCIAL
//     Pitfall 13 mount: the openapi.yaml `servers: - url: /api/v1`
//     declaration means generated routes are /notes/{id}, NOT
//     /api/v1/notes/{id}. The wrapper adds the prefix.
//  6. r.Mount("/", static.Handler()) — SPA fallback LAST. Anything
//     not matching the API tree falls through to the embedded
//     index.html.
func New(cfg Config) (*App, error) {
	notesDir := notesDirFor(cfg.DataDir)
	files := fsstore.NewStore(notesDir)
	// Phase 1 passes nil Index — Phase 2 will inject *db.Index here.
	notesSvc := notes.NewService(files, nil, cfg.Logger)
	apiServer := api.NewServer(notesSvc, cfg.Logger)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(requestLogger(cfg.Logger))

	// ORDER MATTERS — Pitfall 13.
	//
	// 1) API FIRST, mounted UNDER /api/v1 so the generated routes
	//    (which are /notes/{id} per openapi.yaml `paths:` block)
	//    resolve at /api/v1/notes/{id} per the openapi.yaml
	//    `servers: - url: /api/v1` declaration. This MUST match
	//    Plan 02's handler-test mount pattern or dev tests and prod
	//    serve different URLs.
	si := api.NewStrictHandler(apiServer, nil)
	r.Route("/api/v1", func(r chi.Router) {
		// CR-03: cap PUT body size before oapi-codegen reads it into
		// memory. 10 MiB is well above any plausible markdown file
		// (the largest notes in the wild are <1 MiB) and far below
		// the gigabyte-class allocations a runaway frontend bug or
		// curl typo could otherwise force.
		r.Use(maxBodyBytes(maxRequestBodyBytes))
		api.HandlerFromMux(si, r)
	})

	// 2) (no /ws in Phase 1 — Phase 4 will add)

	// 3) SPA fallback LAST. r.Mount registers a catch-all that the
	//    chi tree only consults after the /api/v1 subrouter has had
	//    a chance to match (and 404 cleanly) the request.
	r.Mount("/", static.Handler())

	return &App{cfg: cfg, handler: r}, nil
}

// Handler returns the composed http.Handler for the app — useful
// for httptest in unit tests.
func (a *App) Handler() http.Handler { return a.handler }

// Config returns the resolved configuration the app was built with.
func (a *App) Config() Config { return a.cfg }
