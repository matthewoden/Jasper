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

	dataDir string

	migrationsFS fs.FS

	reindexBusy sync.Mutex

	vaultSwitcher VaultSwitcher

	vaultOpener VaultOpener

	inFlightWrites *sync.WaitGroup

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
// the server's first boot of a newly-created vault can apply schema
// migrations against <vault>/.jasper/app.db (D-04 — CreateVault no
// longer runs migrations; lifecycle does). Called by the composition
// root (app.New / lifecycle.Run) after construction so we don't have
// to evolve NewServerWithIndex's signature for every new Phase 8
// dependency. nil-safe — passing nil leaves the field empty and
// PostSetup will short-circuit with a 500.
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

// SetInFlightWrites wires the *App's inFlightWrites WaitGroup into the
// Server so write handlers can signal to SwitchVault's drain that a write
// is in progress. Called by lifecycle.Run after bootPerVaultSubsystems.
// nil-safe — passing nil is equivalent to no drain tracking.
func (s *Server) SetInFlightWrites(wg *sync.WaitGroup) {
	s.inFlightWrites = wg
}

func (s *Server) trackWrite() func() {
	if s.inFlightWrites == nil {
		return func() {}
	}
	s.inFlightWrites.Add(1)
	return s.inFlightWrites.Done
}

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
	defer s.trackWrite()()
	if request.Body == nil {
		return PutNoteById400JSONResponse(newError("invalid_request", "request body required")), nil
	}

	ifMatch := ""
	if request.Params.IfMatch != nil {
		ifMatch = *request.Params.IfMatch
	}

	note, err := s.notes.Update(ctx, uuid.UUID(request.Id), request.Body.Content, ifMatch)
	if err != nil {
		if errors.Is(err, notes.ErrNotFound) {
			return PutNoteById404JSONResponse(newError("not_found", err.Error())), nil
		}

		if errors.Is(err, notes.ErrStaleWrite) {
			s.log.Error("PutNoteById: stale write detected",
				"id", uuid.UUID(request.Id).String(),
				"err", err,
			)
			var swInfo *notes.StaleWriteInfo
			if !errors.As(err, &swInfo) || swInfo == nil {
				return nil, errors.New("stale write: missing typed payload for conflict response")
			}
			return PutNoteById409JSONResponse(StaleWriteError{
				Code:             StaleWrite,
				Message:          "note was updated in another session; check current_updated_at and retry",
				CurrentUpdatedAt: swInfo.Current,
			}), nil
		}

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
