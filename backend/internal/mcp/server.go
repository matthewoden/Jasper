package mcp

import (
	"context"
	"log/slog"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// NotesProvider is the small adapter the MCP server uses to list every
// note in the vault. The full notes.Service does not expose List; the
// index does (see adapters.go for the wrapper).
type NotesProvider interface {
	List(ctx context.Context) ([]notes.NoteSummary, error)
}

// SearchProvider is the small adapter the MCP server uses to run an
// FTS5 search. Wraps the existing index.SearchFTS path; concrete impl
// is constructed by lifecycle.go (see adapters.go).
type SearchProvider interface {
	Search(ctx context.Context, q string, limit int) ([]SearchHit, error)
}

// AttachmentProvider is the small adapter the MCP server uses to read
// attachment bytes. Wraps the same 5-rule path pipeline that
// api.GetAttachment uses; concrete impl lives in adapters.go.
type AttachmentProvider interface {
	Read(ctx context.Context, noteID, filename string) ([]byte, string, error)
}

// Broadcaster is the subset of *wshub.Hub the MCP server may use. Kept
// as an interface so unit tests can pass a fake without instantiating a
// real hub. MCP write tools never call Broadcast directly — notes.Service
// does (D-57). This interface is reserved for any future MCP-originated
// event that doesn't already flow through notes.Service.
type Broadcaster interface {
	Broadcast(eventType string, payload any, originSessionID string)
}

// Server bundles every dependency the MCP tools need and owns the
// underlying *mcpsdk.Server. Construct via NewServer; the constructor
// registers every tool (D-16) before returning.
type Server struct {
	sdk           *mcpsdk.Server
	notesSvc      *notes.Service
	notesProvider NotesProvider
	searchSvc     SearchProvider
	attachSvc     AttachmentProvider
	acl           *ACL
	broadcaster   Broadcaster
	log           *slog.Logger
}

// NewServer constructs an MCP server with every tool registered.
//
// Parameters:
//   - notesSvc: the production notes.Service. Required.
//   - notesProv: adapter that lists every note (typically wraps index.List).
//   - search: adapter that runs an FTS5 search.
//   - attach: adapter that reads attachment bytes.
//   - acl: the folder-grant ACL from Plan 08-08. Required for write tools.
//   - bcast: the WS hub. Currently unused (notes.Service emits its own
//     events) but kept for forward compat. May be nil.
//   - log: structured logger. A nil logger is replaced with slog.Default().
func NewServer(
	notesSvc *notes.Service,
	notesProv NotesProvider,
	search SearchProvider,
	attach AttachmentProvider,
	acl *ACL,
	bcast Broadcaster,
	log *slog.Logger,
) *Server {
	if log == nil {
		log = slog.Default()
	}
	sdk := mcpsdk.NewServer(&mcpsdk.Implementation{
		Name:    "jasper",
		Title:   "Jasper Notes",
		Version: "0.1.0",
	}, nil)
	s := &Server{
		sdk:           sdk,
		notesSvc:      notesSvc,
		notesProvider: notesProv,
		searchSvc:     search,
		attachSvc:     attach,
		acl:           acl,
		broadcaster:   bcast,
		log:           log,
	}
	s.registerTools()
	return s
}

// SDK returns the underlying SDK server — used by listener.go to
// construct the StreamableHTTPHandler getServer closure.
func (s *Server) SDK() *mcpsdk.Server { return s.sdk }
