package mcp_test

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/matthewoden/jasper/backend/internal/mcp"
)

// TestMCPAlwaysLoopback is the NET-02 regression guard: it asserts the MCP
// listener refuses non-loopback binds regardless of the HTTP server's bind
// address. This must remain green even after the HTTP --bind flag ships.
func TestMCPAlwaysLoopback(t *testing.T) {
	t.Parallel()
	_, err := mcp.StartMCPListener(
		context.Background(),
		newTestMCPServer(t),
		"0.0.0.0:6684",
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err == nil {
		t.Fatal("expected error when binding MCP to non-loopback address; got nil")
	}
	if !strings.Contains(err.Error(), "loopback") {
		t.Errorf("expected loopback error, got: %v", err)
	}
}
