// Package netbind provides loopback-only bind enforcement reused by
// the primary HTTP listener (backend/cmd/jasper/serve.go) and the MCP
// listener (backend/internal/mcp/server.go). Extracted to a separate
// package because the MCP listener cannot import package main.
package netbind

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// LoopbackHosts is the single source of truth for the hostnames Jasper
// treats as its own. Everything that has to answer "is this us?" derives
// from it: the CSRF Origin allowlist, the Host allowlist below, and the
// WebSocket origin patterns.
func LoopbackHosts() []string {
	return []string{"127.0.0.1", "localhost", "::1"}
}

// IsLoopback reports whether host is a loopback address (127.0.0.1, ::1, localhost).
// Called by serve.go to decide whether to log a LAN-exposure warning and by
// doctor/status to report the server bind address.
func IsLoopback(host string) bool {
	for _, h := range LoopbackHosts() {
		if host == h {
			return true
		}
	}
	return false
}

// HostAllowlist is the DNS-rebinding gate. Rebinding dissolves the bind address,
// which ADR-0003 makes Jasper's entire security boundary: the attacker's page
// re-resolves to 127.0.0.1, its fetches become same-origin, and the connection
// is indistinguishable from a legitimate one. Host is the only part of the
// request still naming the attacker.
//
// Only the hostname is compared, never the port: the request already arrived on
// this listener, and requiring the port would break the Vite dev proxy, which
// forwards Host: localhost:5173 to a backend bound on 6683.
type HostAllowlist struct {
	hosts map[string]bool

	// anyIP admits any IP-literal Host. Set only for all-interfaces binds,
	// where the reachable address is not knowable in advance. Rebinding
	// always arrives under a DNS name, so names stay rejected either way.
	anyIP bool
}

// NewHostAllowlist builds the allowlist for a listener bound at addr:
// always the loopback spellings, plus the configured host when addr names
// one explicitly, plus any IP literal when addr is all-interfaces.
//
// ADR-0014 keeps --bind and server.bind working, so a LAN bind must not be
// locked out by its own Host check.
func NewHostAllowlist(addr string) HostAllowlist {
	bindHost, _, err := net.SplitHostPort(addr)
	if err != nil {
		bindHost = "127.0.0.1"
	}
	bindHost = normalizeHostname(bindHost)

	a := LoopbackHostAllowlist()
	switch bindHost {
	case "", "0.0.0.0", "::":
		a.anyIP = true
	default:
		a.hosts[bindHost] = true
	}
	return a
}

// LoopbackHostAllowlist builds an unconditional loopback-only allowlist for
// listeners with no LAN-bind opt-out — the MCP listener (ADR-0013, CONTEXT
// invariant 5), which is loopback-enforced at bind time.
func LoopbackHostAllowlist() HostAllowlist {
	hosts := make(map[string]bool, 4)
	for _, h := range LoopbackHosts() {
		hosts[h] = true
	}
	return HostAllowlist{hosts: hosts}
}

// Allows reports whether hostHeader — an HTTP Host header, with or without
// a port — names a host this server serves.
func (a HostAllowlist) Allows(hostHeader string) bool {
	host := hostHeader
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = normalizeHostname(host)

	if a.hosts[host] {
		return true
	}
	return a.anyIP && net.ParseIP(host) != nil
}

// normalizeHostname lowercases and strips the brackets an IPv6 authority
// carries, so "[::1]" and "::1" compare equal.
func normalizeHostname(h string) string {
	return strings.ToLower(strings.Trim(h, "[]"))
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
