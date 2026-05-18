package mcp_test

// Plan 08-09 — server_test.go covers the SDK composition:
//
//   - NewServer returns a non-nil *Server
//   - All 8 tools (D-16) are registered and discoverable via the
//     SDK's ListTools introspection (over an in-memory transport).
//   - Tool names match the D-16 list exactly.

import (
	"context"
	"io"
	"log/slog"
	"sort"
	"testing"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/matthewoden/jasper/backend/internal/mcp"
)

// expectedToolNames is the D-16 canonical tool name list.
var expectedToolNames = []string{
	"create_note",
	"delete_note",
	"list_notes",
	"move_note",
	"read_attachment",
	"read_note",
	"search_notes",
	"update_note",
}

func TestNewServer_ReturnsNonNilSDK(t *testing.T) {
	t.Parallel()
	srv := newTestMCPServer(t)
	if srv.SDK() == nil {
		t.Fatal("SDK() returned nil")
	}
}

// TestNewServer_All8ToolsRegistered uses the SDK's in-memory transport
// to connect a client and run ListTools — the same path Claude Desktop
// uses. The set of tool names must equal expectedToolNames exactly.
func TestNewServer_All8ToolsRegistered(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	srv := newTestMCPServer(t)

	st, ct := mcpsdk.NewInMemoryTransports()
	ss, err := srv.SDK().Connect(ctx, st, nil)
	if err != nil {
		t.Fatalf("server.Connect: %v", err)
	}
	defer func() { _ = ss.Close() }()

	client := mcpsdk.NewClient(&mcpsdk.Implementation{Name: "test-client", Version: "v0.0.1"}, nil)
	cs, err := client.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatalf("client.Connect: %v", err)
	}
	defer func() { _ = cs.Close() }()

	res, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(res.Tools) != len(expectedToolNames) {
		names := []string{}
		for _, tool := range res.Tools {
			names = append(names, tool.Name)
		}
		t.Fatalf("ListTools returned %d tools, want %d. got=%v",
			len(res.Tools), len(expectedToolNames), names)
	}

	gotNames := []string{}
	for _, tool := range res.Tools {
		gotNames = append(gotNames, tool.Name)
	}
	sort.Strings(gotNames)
	for i, want := range expectedToolNames {
		if gotNames[i] != want {
			t.Errorf("tool[%d]: got %q, want %q", i, gotNames[i], want)
		}
	}
}

// newTestMCPServer constructs a Server with a real notes.Service + a
// fake NotesProvider so the test setup never touches SQLite.
func newTestMCPServer(t *testing.T) *mcp.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	notesSvc, _, _, _ := buildToolFixture(t)
	acl := mcp.NewACL(openTestDB(t))
	return mcp.NewServer(notesSvc, &fakeNotesProvider{}, &fakeSearchProvider{}, &fakeAttachProvider{}, acl, nil, logger)
}
