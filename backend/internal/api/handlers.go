package api

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"sync"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/matthewoden/jasper/backend/internal/db/migrate"
	"github.com/matthewoden/jasper/backend/internal/mcp"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// nilStatusProvider is a no-op StatusProvider used when callers (Phase 1
// tests, fresh-boot paths) construct a Server without wiring the
// migration runner. Always reports StateOK — safe for tests, never
// reached in production because Plan 02-06's composition root always
// passes a real runner.
//
// Lives in handlers.go (next to the Server constructors) so the
// fallback is co-located with its only callers — both NewServer and
// NewServerWithIndex substitute it when the status arg is nil.
type nilStatusProvider struct{}

// Status returns Status{State: ok} so the wire format never carries
// the empty-string state value (which would fail openapi enum
// validation client-side).
func (nilStatusProvider) Status(_ context.Context) migrate.Status {
	return migrate.Status{State: migrate.StateOK}
}

// Server bundles dependencies and implements api.StrictServerInterface.
// Plan 02-06's app.New wires the concrete *notes.Service + runner +
// indexer via NewServerWithIndex (the 5-arg constructor introduced by
// Plan 02-04b, which replaces the 3-arg NewServerWithStatus from Plan
// 02-03 — locked decision B-2).
//
// status, runner, and index can each be nil; the constructor
// substitutes a no-op fallback for status (so admin_status always has
// a source) and the handlers are written to gracefully degrade when
// runner / index are nil (Phase 1 NewServer compatibility):
//   - GetNotes with nil index → returns an empty list (NOT 503).
//   - PostAdminReindex with nil runner → 503 with code "no_runner".
//
// broadcaster is the Phase 4 WebSocket broadcaster port (Plan 04-04).
// In production this is *wshub.Hub; in tests it is nil (graceful
// degradation — no reindex events emitted). We use the interface
// (not *wshub.Hub) to avoid an import cycle: wshub imports api
// (via envelope.go's Amendment 2 bridge), so api MUST NOT import wshub.
type Server struct {
	notes       *notes.Service
	status      migrate.StatusProvider
	runner      *migrate.Runner
	index       notes.Index
	broadcaster notes.Broadcaster
	log         *slog.Logger

	// dataDir is the absolute path under which <dataDir>/storage/config.json
	// lives (Plan 05-02 / 05-03). Phase 5 introduces this field so the new
	// GetConfig + PutConfig handlers can reach the config package without
	// a new constructor variant.
	//
	// Zero-value-safe: if NewServer (the legacy 2-arg form) is used, dataDir
	// is "" and the GetConfig/PutConfig handlers return defaults rather than
	// touching the filesystem. Only NewServerWithIndex (the 7-arg form below)
	// wires a real path.
	dataDir string

	// migrationsFS is the embedded migrations fs.FS used by the wizard
	// submit pipeline (firstrun.RunSetup) to apply schema migrations
	// against the user-chosen <DataDir>/storage/app.db. Plumbed through
	// from app.New (which sources it from cfg.MigrationsOverride or
	// migrations.FS) so the api package doesn't take a direct import
	// dependency on backend/migrations (kept loose for testability).
	//
	// nil-safe: setup_handler.go's PostSetup returns 500 if the field
	// is empty — guards against test-only constructors that didn't
	// wire it.
	migrationsFS fs.FS

	// reindexBusy serializes /admin/reindex calls per-Server.
	// admin_reindex_handler.go uses TryLock to return 409
	// "reindex_in_progress" when busy.
	reindexBusy sync.Mutex

	// mcpACL is the Phase 8 Plan 08-08 folder-grant ACL backing
	// /api/v1/mcp/grants. nil-safe: when MCP is disabled in config
	// (cfg.MCP.Enabled == false) the lifecycle never calls SetMcpACL
	// and the handlers degrade to "mcp_disabled" 400s. The setter
	// pattern (mirrors SetMigrationsFS) lets the composition root
	// inject a real ACL after sqlite.Open + migrate.Run succeed
	// without bloating NewServerWithIndex's signature.
	mcpACL *mcp.ACL
}

// NewServer keeps Phase 1's 2-arg signature so existing call sites and
// tests continue to compile unchanged. Internally delegates to
// NewServerWithIndex with nil status/runner/index/broadcaster and an
// empty dataDir so the nilStatusProvider fallback applies and
// GetNotes / PostAdminReindex / GetConfig / PutConfig degrade gracefully.
func NewServer(notesSvc *notes.Service, log *slog.Logger) *Server {
	return NewServerWithIndex(notesSvc, nil, nil, nil, nil, log, "")
}

// NewServerWithIndex is the 7-arg constructor. Extends the Phase 4 6-arg
// form with a dataDir for Plan 05-03's GetConfig + PutConfig handlers.
//
// Argument order: notesSvc, status, runner, index, broadcaster, log, dataDir.
//
// Plan 02-06's composition root passes a *migrate.Runner for both
// status (it implements StatusProvider) and runner (the same value),
// and a *index.Indexer for index (which implements notes.Index).
//
// We accept notes.Broadcaster (not *wshub.Hub) to avoid an import
// cycle: wshub/envelope.go imports api for the WSEnvelope Amendment 2
// sentinel; api importing wshub would create a cycle.
func NewServerWithIndex(
	notesSvc *notes.Service,
	status migrate.StatusProvider,
	runner *migrate.Runner,
	index notes.Index,
	broadcaster notes.Broadcaster,
	log *slog.Logger,
	dataDir string,
) *Server {
	if log == nil {
		log = slog.Default()
	}
	if status == nil {
		status = nilStatusProvider{}
	}
	return &Server{
		notes:       notesSvc,
		status:      status,
		runner:      runner,
		index:       index,
		broadcaster: broadcaster,
		log:         log,
		dataDir:     dataDir,
	}
}

// SetMigrationsFS wires the embedded migrations.FS into the Server so
// the wizard submit pipeline (firstrun.RunSetup) can apply schema
// migrations against the chosen <DataDir>/storage/app.db. Called by
// the composition root (app.New / lifecycle.Run) after construction
// so we don't have to evolve NewServerWithIndex's signature for every
// new Phase 8 dependency. nil-safe — passing nil leaves the field
// empty and PostSetup will short-circuit with a 500.
func (s *Server) SetMigrationsFS(f fs.FS) {
	s.migrationsFS = f
}

// SetMcpACL wires the folder-grant ACL into the Server so the
// /api/v1/mcp/grants handlers can read/write the mcp_write_grants
// table. Called by the composition root only when cfg.MCP.Enabled is
// true; otherwise the field stays nil and the handlers return
// "mcp_disabled" errors. Mirrors SetMigrationsFS — additive setter so
// the NewServerWithIndex signature doesn't grow for every new Phase 8
// dependency.
func (s *Server) SetMcpACL(acl *mcp.ACL) {
	s.mcpACL = acl
}

// StrictServerInterface compile-time assertion (Plan 08-12 final
// integration — restored after the Wave 1-4 partial-handler period).
// Plans 08-02 / 08-05 / 08-07 / 08-08 / 08-09 each contributed handler
// methods on *Server in their own dedicated files (setup_handler.go,
// reveal_handler.go, notes_by_path_handler.go, mcp_grants_handler.go,
// plus MCP server wiring). This line verifies every spec method on
// StrictServerInterface has a corresponding *Server method. If `make
// gen` emits a new method signature without a matching method on
// *Server, the build fails here with a clear "missing method" error
// — a much sharper signal than the implicit type-check at the
// NewStrictHandler call site in app.go.
//
// Plan 08-01 deleted the pre-existing assertion so each downstream
// wave could build with a partial handler set; 08-12 (this line)
// restores it now that every Phase 8 handler exists.
var _ StrictServerInterface = (*Server)(nil)

// GetNoteById implements GET /api/v1/notes/{id}.
//
// Per ARCHITECTURE.md §13 anti-pattern 1, the handler is a thin shim:
// translate the request, call the domain service, translate the response.
// All business logic lives in notes.Service.
//
// Method name `Id` (not `ID`) is forced by oapi-codegen, which derives the
// StrictServerInterface method names from the OpenAPI operationId.
//
//nolint:revive // generated interface name
func (s *Server) GetNoteById(
	ctx context.Context,
	request GetNoteByIdRequestObject,
) (GetNoteByIdResponseObject, error) {
	note, err := s.notes.Get(ctx, uuid.UUID(request.Id))
	if err != nil {
		if errors.Is(err, notes.ErrNotFound) {
			return GetNoteById404JSONResponse(newError("not_found", err.Error())), nil
		}
		// Any other error is a 500. The OpenAPI spec for GET does not
		// declare a typed 500 response, so we return through the
		// strict-server's default error path — but with a deliberately
		// generic message. The wrapped chain (which includes filesystem
		// paths) is logged server-side only.
		s.log.Error("GetNoteById: domain error",
			"id", uuid.UUID(request.Id).String(),
			"err", err,
		)
		return nil, errors.New("could not load note")
	}
	return GetNoteById200JSONResponse{
		Id:        openapi_types.UUID(note.ID),
		Path:      note.Path,
		Content:   note.Content,
		UpdatedAt: note.UpdatedAt,
	}, nil
}

// PutNoteById implements PUT /api/v1/notes/{id}.
//
//nolint:revive // generated interface name (see GetNoteById)
func (s *Server) PutNoteById(
	ctx context.Context,
	request PutNoteByIdRequestObject,
) (PutNoteByIdResponseObject, error) {
	if request.Body == nil {
		return PutNoteById400JSONResponse(newError("invalid_request", "request body required")), nil
	}

	// SYNC-06: extract If-Match header (oapi-codegen emits *string).
	ifMatch := ""
	if request.Params.IfMatch != nil {
		ifMatch = *request.Params.IfMatch
	}

	note, err := s.notes.Update(ctx, uuid.UUID(request.Id), request.Body.Content, ifMatch)
	if err != nil {
		if errors.Is(err, notes.ErrNotFound) {
			return PutNoteById404JSONResponse(newError("not_found", err.Error())), nil
		}
		// SYNC-06: stale-write 409 with current_updated_at so the
		// client can surface the SYNC-05 conflict banner.
		//
		// BL-02: extract the comparator from the typed *notes.StaleWriteInfo
		// (same Stat result that produced the mismatch verdict) instead of
		// issuing a second s.notes.Get — that follow-up read raced a third
		// writer between Service.Update's Stat and the handler's Get, so the
		// returned current_updated_at could be tied to a write the client
		// never knew about. It also avoided pointless I/O reading the entire
		// file content just to drop everything but the mtime.
		if errors.Is(err, notes.ErrStaleWrite) {
			s.log.Error("PutNoteById: stale write detected",
				"id", uuid.UUID(request.Id).String(),
				"err", err,
			)
			var swInfo *notes.StaleWriteInfo
			if !errors.As(err, &swInfo) || swInfo == nil {
				// Defensive: any code path that wraps ErrStaleWrite
				// without the typed payload is a bug — surface a 500
				// rather than re-introducing the second-Get race.
				return nil, errors.New("stale write: missing typed payload for conflict response")
			}
			return PutNoteById409JSONResponse(StaleWriteError{
				Code:             StaleWrite,
				Message:          "note was updated in another session; check current_updated_at and retry",
				CurrentUpdatedAt: swInfo.Current,
			}), nil
		}
		// Any other error from the domain layer (Canonicalize escape,
		// AtomicWrite IO, Stat, etc.) maps to a 500 with code
		// "write_failed". The wire-format message is intentionally
		// generic — the wrapped chain contains absolute filesystem
		// paths that should not leave the process. We log the full
		// error server-side so an operator can correlate by request ID.
		s.log.Error("PutNoteById: domain error",
			"id", uuid.UUID(request.Id).String(),
			"err", err,
		)
		return PutNoteById500JSONResponse(newError("write_failed", "could not save note")), nil
	}
	return PutNoteById200JSONResponse{
		Id:        openapi_types.UUID(note.ID),
		Path:      note.Path,
		UpdatedAt: note.UpdatedAt,
	}, nil
}
