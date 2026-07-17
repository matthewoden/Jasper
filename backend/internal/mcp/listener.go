package mcp

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/matthewoden/jasper/backend/internal/netbind"
)

// Logger is the structured-logger subset the listener needs.
// Compatible with *slog.Logger as well as test-only fakes.
type Logger interface {
	Info(msg string, args ...any)
	Error(msg string, args ...any)
}

// StartMCPListener binds the MCP HTTP listener on bindAddr and serves
// the StreamableHTTP endpoint at /mcp. Returns the *http.Server so the
// caller can Shutdown(ctx) it during app exit.
//
// Bind is enforced loopback-only via netbind. Caller must invoke this
// after lifecycle.Ready() returns true.
//
// The /mcp endpoint is the MCP protocol entry point; /healthz returns
// 200 OK for liveness probes.
func StartMCPListener(_ context.Context, server *Server, bindAddr string, log Logger) (*http.Server, error) {
	if err := netbind.RequireLoopbackBind(bindAddr); err != nil {
		return nil, fmt.Errorf("MCP listener: %w", err)
	}

	// Bind synchronously so callers (lifecycle boot/swap) can distinguish
	// a failed bind (e.g. port already in use) from a successful one and
	// surface it via admin/status (D-05). Previously ListenAndServe() ran
	// entirely inside the goroutine below, so a bind failure was only
	// logged — never returned — and the caller believed MCP was up.
	ln, err := net.Listen("tcp", bindAddr)
	if err != nil {
		return nil, fmt.Errorf("MCP listener: %w", err)
	}

	mux := http.NewServeMux()
	handler := mcpsdk.NewStreamableHTTPHandler(func(_ *http.Request) *mcpsdk.Server {
		return server.SDK()
	}, nil)
	mux.Handle("/mcp", handler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	srv := &http.Server{
		Addr:              bindAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Info("MCP listener starting", "addr", bindAddr)
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("MCP listener exited", "err", err)
		}
	}()
	return srv, nil
}
