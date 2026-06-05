package mcp_test

import (
	"context"
	"io"
	"log/slog"
	"sort"
	"testing"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/matthewoden/jasper/backend/internal/mcp"
)

var expectedToolNames = []string{
	"create_note",
	"delete_note",
	"list_grants",
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

// TestNewServer_All8ToolsRegistered (now 9 tools — list_grants added 08-21)
// uses the SDK's in-memory transport
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

func newTestMCPServer(t *testing.T) *mcp.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	notesSvc, _, _, _ := buildToolFixture(t)
	acl := mcp.NewACL(openTestDB(t))
	return mcp.NewServer(notesSvc, &fakeNotesProvider{}, &fakeSearchProvider{}, &fakeAttachProvider{}, acl, nil, logger)
}
