package api

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"sync"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/matthewoden/jasper/backend/internal/bookmarks"
	"github.com/matthewoden/jasper/backend/internal/db/migrate"
	"github.com/matthewoden/jasper/backend/internal/mcp"
	"github.com/matthewoden/jasper/backend/internal/notes"
	"github.com/matthewoden/jasper/backend/internal/workspace"
)

type nilStatusProvider struct{}

// Status returns Status{State: ok} so the wire format never carries
// the empty-string state value (which would fail openapi enum
// validation client-side).
func (nilStatusProvider) Status(_ context.Context) migrate.Status {
	return migrate.Status{State: migrate.StateOK}
}

// Server bundles dependencies and implements api.StrictServerInterface.
//
// status, runner and index may each be nil; handlers degrade rather than 503.
// broadcaster is an interface, not *wshub.Hub, because wshub imports api —
// taking the concrete type would be an import cycle.
type Server struct {
	notes       *notes.Service
	status      migrate.StatusProvider
	runner      *migrate.Runner
	index       notes.Index
	broadcaster notes.Broadcaster
	log         *slog.Logger

	bookmarks *bookmarks.Service
	workspace *workspace.Service

	dataDir string

	migrationsFS fs.FS

	reindexBusy sync.Mutex

	vaultSwitcher VaultSwitcher

	vaultOpener VaultOpener

	inFlightWrites *sync.WaitGroup

	mcpACL *mcp.ACL

	mcpStatusReader McpStatusReader
}

// McpStatusReader reports whether the MCP listener is currently bound
// (and, if not, a human-readable reason). Implemented by *app.App;
// accepted as an interface here to avoid api importing app (app already
// imports api).
type McpStatusReader interface {
	McpStatus() (up bool, reason string)
}

// NewServer is the minimal 2-arg constructor. Delegates to NewServerWithIndex
// with nil status/runner/index/broadcaster so all handlers degrade gracefully.
func NewServer(notesSvc *notes.Service, log *slog.Logger) *Server {
	return NewServerWithIndex(notesSvc, nil, nil, nil, nil, log, "")
}

// NewServerWithIndex is the full 7-arg constructor.
//
// Argument order: notesSvc, status, runner, index, broadcaster, log, dataDir.
//
// We accept notes.Broadcaster (not *wshub.Hub) to avoid an import cycle:
// wshub imports api, so api must not import wshub.
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
	var registry *notes.Registry
	if notesSvc != nil {
		registry = notesSvc.Registry()
	}
	return &Server{
		notes:       notesSvc,
		status:      status,
		runner:      runner,
		index:       index,
		broadcaster: broadcaster,
		log:         log,
		dataDir:     dataDir,
		bookmarks:   bookmarks.New(dataDir, registry, broadcaster, log),
		workspace:   workspace.New(dataDir, broadcaster, log),
	}
}

// SetMigrationsFS wires the embedded migrations.FS into the Server so the
// server can apply schema migrations against <vault>/.jasper/app.db on first
// boot of a newly-created vault. Additive setter — avoids growing
// NewServerWithIndex's signature. nil-safe; PostSetup short-circuits with 500
// when nil.
func (s *Server) SetMigrationsFS(f fs.FS) {
	s.migrationsFS = f
}

// SetMcpACL wires the folder-grant ACL into the Server so the
// /api/v1/mcp/grants handlers can read/write mcp_write_grants. Called
// unconditionally by the composition root at boot; nil field causes
// handlers to return "mcp_disabled" errors.
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

// SetMcpStatusReader wires the *App's MCP listener status into the Server
// so GetAdminStatus can report mcp.up/mcp.reason. Called unconditionally
// by the composition root at boot and on every vault swap; nil field means
// admin/status omits the mcp object entirely (matches the optional schema).
func (s *Server) SetMcpStatusReader(r McpStatusReader) {
	s.mcpStatusReader = r
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
// Thin shim: translate request → call domain service → translate response.
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

		s.log.Error(
			"GetNoteById: domain error",
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
			s.log.Error(
				"PutNoteById: stale write detected",
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

		s.log.Error(
			"PutNoteById: domain error",
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
