package wshub_test

import (
	"bufio"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/matthewoden/jasper/backend/internal/wshub"
)

// rawUpgrade performs a WebSocket handshake over a raw TCP connection so the
// test can set Host freely. A browser treats Host as a forbidden header and a
// WS client library derives it from the dial URL, so a rebound Host is only
// forgeable at this layer.
//
// Returns the response status line.
func rawUpgrade(t *testing.T, addr, host, origin string) string {
	t.Helper()

	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	defer conn.Close() //nolint:errcheck
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}

	req := fmt.Sprintf(
		"GET /api/v1/ws HTTP/1.1\r\n"+
			"Host: %s\r\n"+
			"Upgrade: websocket\r\n"+
			"Connection: Upgrade\r\n"+
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"+
			"Sec-WebSocket-Version: 13\r\n"+
			"Origin: %s\r\n"+
			"\r\n", host, origin)
	if _, err := io.WriteString(conn, req); err != nil {
		t.Fatalf("write handshake: %v", err)
	}

	statusLine, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatalf("read status line: %v", err)
	}
	return strings.TrimSpace(statusLine)
}

// TestHub_RejectsReboundHost is the WebSocket rebinding gate. coder/websocket authorizes
// the upgrade BEFORE consulting OriginPatterns whenever Origin's host equals
// the Host header (accept.go: `if strings.EqualFold(r.Host, u.Host)`). Under
// DNS rebinding those two are equal by construction, so OriginPatterns
// provides exactly zero protection and the attacker receives the broadcast
// stream — note paths, titles, and activity.
//
// The shortcut is inherent to the library, so the Hub checks Host itself
// rather than relying on the router-root middleware alone.
func TestHub_RejectsReboundHost(t *testing.T) {
	hub := wshub.New(slog.New(slog.NewTextHandler(io.Discard, nil)), "127.0.0.1:6683")
	srv := httptest.NewServer(hub)
	defer srv.Close()
	addr := srv.Listener.Addr().String()

	status := rawUpgrade(t, addr, "evil.com:6683", "http://evil.com:6683")
	if !strings.Contains(status, "403") {
		t.Errorf("rebound Host upgrade: got %q, want 403", status)
	}
}

// TestHub_AcceptsLoopbackHost is the companion happy path: the Host check
// must not break legitimate upgrades.
func TestHub_AcceptsLoopbackHost(t *testing.T) {
	hub := wshub.New(slog.New(slog.NewTextHandler(io.Discard, nil)), "127.0.0.1:6683")
	srv := httptest.NewServer(hub)
	defer srv.Close()
	addr := srv.Listener.Addr().String()

	status := rawUpgrade(t, addr, addr, "http://"+addr)
	if !strings.Contains(status, "101") {
		t.Errorf("loopback upgrade: got %q, want 101 Switching Protocols", status)
	}
}
