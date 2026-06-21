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

// IsLoopback reports whether host is a loopback address (127.0.0.1, ::1, localhost).
// Called by serve.go to decide whether to log a LAN-exposure warning and by
// doctor/status to report the server bind address.
func IsLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// RequireLoopbackBind returns nil when addr's host is loopback
// (127.0.0.1, ::1, or "localhost"); otherwise an error.
//
// Empty-host shorthand like ":3000" is REJECTED because net.Listen
// treats it as 0.0.0.0 (all interfaces). Callers must spell the host
// explicitly so a typo doesn't silently expose the listener to the LAN.
func RequireLoopbackBind(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid --bind %q: %w", addr, err)
	}
	if IsLoopback(host) {
		return nil
	}

	return errors.New(
		"MCP listener only allows binding to loopback (localhost / 127.0.0.1 / ::1); " +
			"set server.bind in config to expose the HTTP listener on LAN",
	)
}
