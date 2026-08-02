package mcp_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
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

// Bind posture alone does not survive DNS rebinding: a rebound page reaches
// 127.0.0.1:6684 over a genuine loopback connection, and only the Host header
// still names evil.com. See hostAllowlistHandler for why the CORS preflight is
// not enough on its own.
func TestMCPListener_RejectsReboundHost(t *testing.T) {
	t.Parallel()

	srv, err := mcp.StartMCPListener(
		context.Background(),
		newTestMCPServer(t),
		"127.0.0.1:0",
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		t.Fatalf("StartMCPListener: %v", err)
	}
	defer func() { _ = srv.Close() }()

	addr := srv.Addr

	// The body matters, not just the status: the MCP SDK answers a bare GET
	// /mcp with its own 403, so a status-only assertion would pass whether or
	// not the Host gate exists.
	probe := func(path, host string) (int, string) {
		req, reqErr := http.NewRequest(http.MethodGet, "http://"+addr+path, nil)
		if reqErr != nil {
			t.Fatalf("NewRequest: %v", reqErr)
		}
		req.Host = host
		resp, doErr := http.DefaultClient.Do(req)
		if doErr != nil {
			t.Fatalf("GET %s (host=%q): %v", path, host, doErr)
		}
		defer func() { _ = resp.Body.Close() }()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}

	for _, path := range []string{"/mcp", "/healthz"} {
		status, body := probe(path, "evil.com:6684")
		if status != http.StatusForbidden || !strings.Contains(body, "forbidden Host") {
			t.Errorf("GET %s with rebound Host: got %d %q, want 403 \"forbidden Host\"",
				path, status, strings.TrimSpace(body))
		}
		if _, body := probe(path, addr); strings.Contains(body, "forbidden Host") {
			t.Errorf("GET %s with loopback Host: rejected by the Host gate, want it to pass", path)
		}
	}
}
