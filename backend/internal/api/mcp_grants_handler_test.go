package api

// mcp_grants_handler_test.go — Plan 08-08 Task 2 unit tests for the
// three /mcp/grants strict-server handlers. Builds a *Server with a
// real *mcp.ACL backed by an in-memory SQLite DB (full migration
// chain applied) and a recording broadcaster spy.

import (
	"context"
	"database/sql"
	"io"
	"io/fs"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/matthewoden/jasper/backend/internal/mcp"
	"github.com/matthewoden/jasper/backend/migrations"
)

// recordingBroadcaster is a tiny broadcaster spy. Implements
// notes.Broadcaster (Broadcast(eventType, payload, sessionID)) so it
// can be assigned to Server.broadcaster directly via the
// struct-literal constructor below.
type recordingBroadcaster struct {
	mu     sync.Mutex
	events []recordedEvent
}

type recordedEvent struct {
	eventType string
	payload   any
	sessionID string
}

func (b *recordingBroadcaster) Broadcast(eventType string, payload any, sessionID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(b.events, recordedEvent{eventType, payload, sessionID})
}

func (b *recordingBroadcaster) countByType(eventType string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, e := range b.events {
		if e.eventType == eventType {
			n++
		}
	}
	return n
}

func (b *recordingBroadcaster) lastByType(eventType string) (recordedEvent, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i := len(b.events) - 1; i >= 0; i-- {
		if b.events[i].eventType == eventType {
			return b.events[i], true
		}
	}
	return recordedEvent{}, false
}

// openTestDBForGrants opens a fresh on-disk SQLite, applies every
// embedded migration, and returns the *sql.DB. Mirrors
// internal/mcp/acl_test.go's helper (intentionally duplicated; the
// helpers don't justify a shared testutil package yet).
func openTestDBForGrants(t *testing.T) *sql.DB {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	dsn := "file:" + dbPath + "?_pragma=foreign_keys(ON)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatalf("ReadDir migrations.FS: %v", err)
	}
	ctx := context.Background()
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if len(name) < 4 || name[len(name)-4:] != ".sql" {
			continue
		}
		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if _, err := db.ExecContext(ctx, string(body)); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
	}
	return db
}

// newGrantServer builds a *Server with mcpACL + broadcaster wired,
// matching the production composition root for MCP-enabled configs.
// Returns both the server and the broadcaster so tests can assert
// against the spy.
func newGrantServer(t *testing.T) (*Server, *recordingBroadcaster) {
	t.Helper()
	db := openTestDBForGrants(t)
	br := &recordingBroadcaster{}
	s := &Server{
		log:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		broadcaster: br,
		mcpACL:      mcp.NewACL(db),
	}
	return s, br
}

// newDisabledGrantServer builds a *Server with mcpACL == nil so the
// handlers exercise the "MCP disabled" branch.
func newDisabledGrantServer(t *testing.T) *Server {
	t.Helper()
	return &Server{
		log:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		broadcaster: &recordingBroadcaster{},
	}
}

// ---------------------------------------------------------------------------
// GET /mcp/grants
// ---------------------------------------------------------------------------

func TestGetMcpGrants_Empty(t *testing.T) {
	s, _ := newGrantServer(t)
	resp, err := s.GetMcpGrants(context.Background(), GetMcpGrantsRequestObject{})
	if err != nil {
		t.Fatalf("GetMcpGrants: %v", err)
	}
	r200, ok := resp.(GetMcpGrants200JSONResponse)
	if !ok {
		t.Fatalf("expected GetMcpGrants200JSONResponse, got %T", resp)
	}
	if len(r200.Grants) != 0 {
		t.Errorf("expected 0 grants, got %d", len(r200.Grants))
	}
}

func TestGetMcpGrants_McpDisabled_StillReturnsEmptyList(t *testing.T) {
	s := newDisabledGrantServer(t)
	resp, err := s.GetMcpGrants(context.Background(), GetMcpGrantsRequestObject{})
	if err != nil {
		t.Fatalf("GetMcpGrants: %v", err)
	}
	r200, ok := resp.(GetMcpGrants200JSONResponse)
	if !ok {
		t.Fatalf("expected GetMcpGrants200JSONResponse, got %T", resp)
	}
	if len(r200.Grants) != 0 {
		t.Errorf("expected empty list when MCP disabled, got %d", len(r200.Grants))
	}
}

// ---------------------------------------------------------------------------
// POST /mcp/grants — happy path + tier upgrade + broadcast
// ---------------------------------------------------------------------------

func TestMcpGrants_PostThenGet_RoundTrip(t *testing.T) {
	s, br := newGrantServer(t)
	ctx := context.Background()

	body := &McpGrantRequest{FolderPath: "projects", Level: 1}
	resp, err := s.PostMcpGrant(ctx, PostMcpGrantRequestObject{Body: body})
	if err != nil {
		t.Fatalf("PostMcpGrant: %v", err)
	}
	r200, ok := resp.(PostMcpGrant200JSONResponse)
	if !ok {
		t.Fatalf("expected PostMcpGrant200JSONResponse, got %T (resp=%+v)", resp, resp)
	}
	if r200.FolderPath != "projects" || r200.Level != 1 {
		t.Errorf("got %+v, want folder=projects level=1", r200)
	}

	// Broadcast spy: exactly one EventMcpGrantChanged event, action=set.
	if got := br.countByType(EventMcpGrantChanged); got != 1 {
		t.Errorf("broadcaster: got %d EventMcpGrantChanged events, want 1", got)
	}
	ev, _ := br.lastByType(EventMcpGrantChanged)
	if ev.sessionID != "" {
		t.Errorf("sessionID = %q, want empty (server-originated)", ev.sessionID)
	}
	payload, ok := ev.payload.(map[string]any)
	if !ok {
		t.Fatalf("payload type = %T, want map[string]any", ev.payload)
	}
	if payload["action"] != "set" {
		t.Errorf("payload action = %v, want set", payload["action"])
	}

	// GET shows the new grant.
	gResp, err := s.GetMcpGrants(ctx, GetMcpGrantsRequestObject{})
	if err != nil {
		t.Fatalf("GetMcpGrants: %v", err)
	}
	g200 := gResp.(GetMcpGrants200JSONResponse)
	if len(g200.Grants) != 1 || g200.Grants[0].FolderPath != "projects" {
		t.Errorf("GET after POST = %+v", g200.Grants)
	}
}

func TestPostMcpGrant_UpgradesTier_KeepsSingleRow(t *testing.T) {
	s, _ := newGrantServer(t)
	ctx := context.Background()

	body1 := &McpGrantRequest{FolderPath: "projects", Level: 1}
	if _, err := s.PostMcpGrant(ctx, PostMcpGrantRequestObject{Body: body1}); err != nil {
		t.Fatalf("PostMcpGrant tier1: %v", err)
	}
	body2 := &McpGrantRequest{FolderPath: "projects", Level: 2}
	resp, err := s.PostMcpGrant(ctx, PostMcpGrantRequestObject{Body: body2})
	if err != nil {
		t.Fatalf("PostMcpGrant tier2: %v", err)
	}
	r200, ok := resp.(PostMcpGrant200JSONResponse)
	if !ok {
		t.Fatalf("expected PostMcpGrant200JSONResponse, got %T", resp)
	}
	if r200.Level != 2 {
		t.Errorf("upgraded Level = %d, want 2", r200.Level)
	}

	gResp, _ := s.GetMcpGrants(ctx, GetMcpGrantsRequestObject{})
	g200 := gResp.(GetMcpGrants200JSONResponse)
	if len(g200.Grants) != 1 {
		t.Errorf("expected ONE row after upgrade, got %d", len(g200.Grants))
	}
	if g200.Grants[0].Level != 2 {
		t.Errorf("upgraded row Level = %d, want 2", g200.Grants[0].Level)
	}
}

// ---------------------------------------------------------------------------
// POST /mcp/grants — validation & disabled
// ---------------------------------------------------------------------------

func TestPostMcpGrant_InvalidPath_Returns400(t *testing.T) {
	s, _ := newGrantServer(t)
	body := &McpGrantRequest{FolderPath: "../etc", Level: 1}
	resp, err := s.PostMcpGrant(context.Background(), PostMcpGrantRequestObject{Body: body})
	if err != nil {
		t.Fatalf("PostMcpGrant: %v", err)
	}
	r400, ok := resp.(PostMcpGrant400JSONResponse)
	if !ok {
		t.Fatalf("expected PostMcpGrant400JSONResponse, got %T", resp)
	}
	if r400.Code != "invalid_path" {
		t.Errorf("code = %q, want invalid_path", r400.Code)
	}
}

func TestPostMcpGrant_InvalidLevel_Returns400(t *testing.T) {
	s, _ := newGrantServer(t)
	// Level=3 is rejected by the OpenAPI enum *upstream*; the strict
	// server will normally return 400 before reaching this handler.
	// Here we simulate the case where some non-strict caller sneaks
	// past — ACL.Set is the last line of defense. The handler maps
	// the resulting err to 400 invalid_path.
	body := &McpGrantRequest{FolderPath: "projects", Level: 3}
	resp, err := s.PostMcpGrant(context.Background(), PostMcpGrantRequestObject{Body: body})
	if err != nil {
		t.Fatalf("PostMcpGrant: %v", err)
	}
	r400, ok := resp.(PostMcpGrant400JSONResponse)
	if !ok {
		t.Fatalf("expected PostMcpGrant400JSONResponse, got %T", resp)
	}
	if r400.Code != "invalid_path" {
		t.Errorf("code = %q, want invalid_path", r400.Code)
	}
}

func TestPostMcpGrant_NilBody_Returns400(t *testing.T) {
	s, _ := newGrantServer(t)
	resp, err := s.PostMcpGrant(context.Background(), PostMcpGrantRequestObject{Body: nil})
	if err != nil {
		t.Fatalf("PostMcpGrant: %v", err)
	}
	r400, ok := resp.(PostMcpGrant400JSONResponse)
	if !ok {
		t.Fatalf("expected PostMcpGrant400JSONResponse, got %T", resp)
	}
	if r400.Code != "invalid_request" {
		t.Errorf("code = %q, want invalid_request", r400.Code)
	}
}

func TestPostMcpGrant_McpDisabled_Returns400(t *testing.T) {
	s := newDisabledGrantServer(t)
	body := &McpGrantRequest{FolderPath: "projects", Level: 1}
	resp, err := s.PostMcpGrant(context.Background(), PostMcpGrantRequestObject{Body: body})
	if err != nil {
		t.Fatalf("PostMcpGrant: %v", err)
	}
	r400, ok := resp.(PostMcpGrant400JSONResponse)
	if !ok {
		t.Fatalf("expected PostMcpGrant400JSONResponse, got %T", resp)
	}
	if r400.Code != "mcp_disabled" {
		t.Errorf("code = %q, want mcp_disabled", r400.Code)
	}
}

// ---------------------------------------------------------------------------
// DELETE /mcp/grants
// ---------------------------------------------------------------------------

func TestDeleteMcpGrant_Existing_Returns204_AndBroadcasts(t *testing.T) {
	s, br := newGrantServer(t)
	ctx := context.Background()

	// Seed a grant first.
	body := &McpGrantRequest{FolderPath: "projects", Level: 1}
	if _, err := s.PostMcpGrant(ctx, PostMcpGrantRequestObject{Body: body}); err != nil {
		t.Fatalf("seed PostMcpGrant: %v", err)
	}
	// Reset broadcast counter expectations: we'll assert revoke = +1.
	setCount := br.countByType(EventMcpGrantChanged)

	resp, err := s.DeleteMcpGrant(ctx, DeleteMcpGrantRequestObject{
		Params: DeleteMcpGrantParams{Path: "projects"},
	})
	if err != nil {
		t.Fatalf("DeleteMcpGrant: %v", err)
	}
	if _, ok := resp.(DeleteMcpGrant204Response); !ok {
		t.Fatalf("expected DeleteMcpGrant204Response, got %T", resp)
	}

	// Broadcast asserted: one more EventMcpGrantChanged event with
	// action=revoked.
	if got := br.countByType(EventMcpGrantChanged); got != setCount+1 {
		t.Errorf("broadcaster: got %d total events, want %d (one new revoke)", got, setCount+1)
	}
	ev, _ := br.lastByType(EventMcpGrantChanged)
	payload, ok := ev.payload.(map[string]any)
	if !ok {
		t.Fatalf("payload type = %T, want map[string]any", ev.payload)
	}
	if payload["action"] != "revoked" {
		t.Errorf("action = %v, want revoked", payload["action"])
	}
	if ev.sessionID != "" {
		t.Errorf("sessionID = %q, want empty", ev.sessionID)
	}

	// GET shows 0 rows.
	gResp, _ := s.GetMcpGrants(ctx, GetMcpGrantsRequestObject{})
	if len(gResp.(GetMcpGrants200JSONResponse).Grants) != 0 {
		t.Errorf("expected 0 grants after revoke, got %d",
			len(gResp.(GetMcpGrants200JSONResponse).Grants))
	}
}

func TestDeleteMcpGrant_NonExistent_Returns204_Idempotent(t *testing.T) {
	s, _ := newGrantServer(t)
	resp, err := s.DeleteMcpGrant(context.Background(), DeleteMcpGrantRequestObject{
		Params: DeleteMcpGrantParams{Path: "never-existed"},
	})
	if err != nil {
		t.Fatalf("DeleteMcpGrant non-existent: %v", err)
	}
	if _, ok := resp.(DeleteMcpGrant204Response); !ok {
		t.Fatalf("expected DeleteMcpGrant204Response (idempotent), got %T", resp)
	}
}

func TestDeleteMcpGrant_McpDisabled_Returns404(t *testing.T) {
	s := newDisabledGrantServer(t)
	resp, err := s.DeleteMcpGrant(context.Background(), DeleteMcpGrantRequestObject{
		Params: DeleteMcpGrantParams{Path: "projects"},
	})
	if err != nil {
		t.Fatalf("DeleteMcpGrant: %v", err)
	}
	r404, ok := resp.(DeleteMcpGrant404JSONResponse)
	if !ok {
		t.Fatalf("expected DeleteMcpGrant404JSONResponse, got %T", resp)
	}
	if r404.Code != "mcp_disabled" {
		t.Errorf("code = %q, want mcp_disabled", r404.Code)
	}
}
