// Package netbind provides loopback-only bind enforcement reused by
// the primary HTTP listener (backend/cmd/jasper/serve.go) and the MCP
// listener (backend/internal/mcp/server.go). Extracted to a separate
// package because the MCP listener cannot import package main.
package netbind

import (
	"errors"
	"fmt"
	"net"
)

// RequireLoopbackBind returns nil when addr's host is loopback
// (127.0.0.1, ::1, or "localhost"); otherwise an error.
//
// Empty-host shorthand like ":3000" is REJECTED because net.Listen
// treats it as 0.0.0.0 (all interfaces). Callers must spell the host
// explicitly so a typo doesn't silently expose the listener to the LAN.
//
// The error string is stable — smoke tests, log greps, and downstream
// MCP tests all match the same literal.
func RequireLoopbackBind(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid --addr %q: %w", addr, err)
	}
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return nil
	}

	return errors.New(
		"phase 1 only allows binding to loopback (localhost / 127.0.0.1 / ::1); " +
			"0.0.0.0 will be revisited in phase 8",
	)
}
