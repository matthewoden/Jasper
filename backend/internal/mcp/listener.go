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
	// surface it via admin/status. Previously ListenAndServe() ran
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
		// Addr reports the address actually bound, not the one requested,
		// so an ephemeral ":0" bind is resolvable by the caller.
		Addr:              ln.Addr().String(),
		Handler:           hostAllowlistHandler(mux, log),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Info("MCP listener starting", "addr", srv.Addr)
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("MCP listener exited", "err", err)
		}
	}()
	return srv, nil
}

// hostAllowlistHandler closes DNS rebinding against MCP. Unconditional — MCP is
// loopback-enforced with no opt-out (ADR-0013), so there is no LAN-bind case.
//
// The CORS preflight on MCP's JSON-RPC POST already blocks most browser-driven
// exploitation, but that is incidental: it rests on the SDK's transport choice
// and browser behavior, neither of which Jasper controls.
func hostAllowlistHandler(next http.Handler, log Logger) http.Handler {
	allowlist := netbind.LoopbackHostAllowlist()

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowlist.Allows(r.Host) {
			log.Error("MCP: rejecting request with non-allowlisted Host",
				"host", r.Host, "remote_addr", r.RemoteAddr)
			http.Error(w, "forbidden Host", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
