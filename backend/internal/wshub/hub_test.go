package wshub_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	apigen "github.com/matthewoden/jasper/backend/internal/api"
	"github.com/matthewoden/jasper/backend/internal/wshub"
)

func newTestHub(t *testing.T) *wshub.Hub {
	t.Helper()
	return wshub.New(slog.New(slog.NewTextHandler(io.Discard, nil)))
}

// dialClient opens a WS to srv.URL with `?session_id=<sid>`, reads the
// first message which is the handshake envelope, and returns the
// connection + the confirmed session_id from the handshake.
//
// WR-01: ServeHTTP rejects empty Origin headers as defense-in-depth
// against the coder/websocket authenticateOrigin no-op-on-empty path,
// so the dial sets an explicit localhost Origin matching OriginPatterns.
func dialClient(t *testing.T, srvURL, sid string) (*websocket.Conn, string) {
	t.Helper()
	wsURL := strings.Replace(srvURL, "http://", "ws://", 1)
	if sid != "" {
		wsURL += "?session_id=" + sid
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{srvURL}},
	})
	if err != nil {
		t.Fatalf("dialClient: websocket.Dial: %v", err)
	}

	// Read handshake — the server sends a session:assigned message first.
	// Amendment 2: decode into apigen.WSEnvelope to bind to the generated type.
	var env apigen.WSEnvelope
	readCtx, readCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer readCancel()
	if err := wsjson.Read(readCtx, conn, &env); err != nil {
		t.Fatalf("dialClient: read handshake: %v", err)
	}
	if string(env.Event) != wshub.EventSessionAssigned {
		t.Fatalf("dialClient: expected event %q, got %q", wshub.EventSessionAssigned, env.Event)
	}

	// Extract session_id from the payload map.
	// apigen.WSEnvelope.Payload is interface{}; after JSON decode it's
	// map[string]interface{} — re-marshal and unmarshal to get string values.
	rawPayload, err := json.Marshal(env.Payload)
	if err != nil {
		t.Fatalf("dialClient: marshal payload: %v", err)
	}
	var payload map[string]string
	if err := json.Unmarshal(rawPayload, &payload); err != nil {
		t.Fatalf("dialClient: unmarshal payload as map[string]string: %v", err)
	}
	return conn, payload["session_id"]
}

// TestHub_HandshakeAssignsSessionID verifies that after a WS upgrade
// with ?session_id=sid-A, the server responds with event=session:assigned
// and echoes the same sid (SYNC-01).
func TestHub_HandshakeAssignsSessionID(t *testing.T) {
	hub := newTestHub(t)
	srv := httptest.NewServer(hub)
	defer srv.Close()

	const sid = "sid-A"
	conn, gotSID := dialClient(t, srv.URL, sid)
	defer conn.CloseNow() //nolint:errcheck

	if gotSID != sid {
		t.Errorf("handshake session_id: got %q, want %q", gotSID, sid)
	}
}

// TestHub_BroadcastFanOutExceptOrigin verifies that a Broadcast call
// fans out to all connected clients EXCEPT the originating session
// (SYNC-03 origin filter).
func TestHub_BroadcastFanOutExceptOrigin(t *testing.T) {
	hub := newTestHub(t)
	srv := httptest.NewServer(hub)
	defer srv.Close()

	connA, sidA := dialClient(t, srv.URL, "sid-A")
	defer connA.CloseNow() //nolint:errcheck
	connB, sidB := dialClient(t, srv.URL, "sid-B")
	defer connB.CloseNow() //nolint:errcheck

	// Sanity: confirm both sids are as expected.
	if sidA != "sid-A" {
		t.Fatalf("sidA mismatch: %q", sidA)
	}
	if sidB != "sid-B" {
		t.Fatalf("sidB mismatch: %q", sidB)
	}

	// Broadcast originating from sidA — sidB MUST receive it; sidA MUST NOT.
	hub.Broadcast(wshub.EventNoteUpdated, map[string]string{"id": "n1"}, sidA)

	// sidB should receive the broadcast within 1s.
	// Amendment 2: decode into apigen.WSEnvelope for type safety.
	recvCtx, recvCancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer recvCancel()
	var envB apigen.WSEnvelope
	if err := wsjson.Read(recvCtx, connB, &envB); err != nil {
		t.Fatalf("sidB: expected broadcast, got error: %v", err)
	}
	if string(envB.Event) != wshub.EventNoteUpdated {
		t.Errorf("sidB event: got %q, want %q", envB.Event, wshub.EventNoteUpdated)
	}

	// sidA should NOT receive the broadcast (origin filtered).
	// 200ms timeout is correct for a negative assertion.
	noRecvCtx, noRecvCancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer noRecvCancel()
	var envA apigen.WSEnvelope
	err := wsjson.Read(noRecvCtx, connA, &envA)
	if err == nil {
		t.Errorf("sidA: should NOT receive broadcast (origin filter), but got event %q", envA.Event)
	}
}

// TestHub_SlowClientDropped verifies that a slow client (full send
// channel) is dropped via closeSlow without blocking the broadcast
// goroutine (SYNC-08). Uses RegisterFake to avoid a real WS connection.
func TestHub_SlowClientDropped(t *testing.T) {
	hub := newTestHub(t)

	dropped := make(chan struct{})
	closeSlow := func() {
		close(dropped)
	}

	// bufSize=0: channel is full from the start. Any broadcast will hit
	// the default: branch immediately.
	wshub.RegisterFake(hub, "slow-client", 0, closeSlow)

	start := time.Now()
	hub.Broadcast(wshub.EventNoteUpdated, map[string]string{"id": "n1"}, "other-origin")
	elapsed := time.Since(start)

	// Broadcast must return quickly — the non-blocking select must not
	// block waiting for the slow client.
	if elapsed > 10*time.Millisecond {
		t.Errorf("Broadcast blocked for %v; expected < 10ms (slow-client drop must be non-blocking)", elapsed)
	}

	// closeSlow must be invoked (in a goroutine) within 1s.
	select {
	case <-dropped:
		// OK — closeSlow was invoked.
	case <-time.After(1 * time.Second):
		t.Error("closeSlow was not invoked within 1s")
	}
}

// TestHub_DisconnectCleanup verifies that after a client closes its
// connection, the hub removes it from the registry (no resource leak).
func TestHub_DisconnectCleanup(t *testing.T) {
	hub := newTestHub(t)
	srv := httptest.NewServer(hub)
	defer srv.Close()

	conn, _ := dialClient(t, srv.URL, "sid-cleanup")
	if hub.ClientCount() != 1 {
		t.Fatalf("expected 1 client after connect, got %d", hub.ClientCount())
	}

	// Close the client connection.
	conn.Close(websocket.StatusNormalClosure, "bye") //nolint:errcheck

	// Poll until the hub removes the client (the readPump exits and
	// triggers unregister via defer). Should happen well within 500ms.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if hub.ClientCount() == 0 {
			return // test passes
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Errorf("expected 0 clients after disconnect, got %d", hub.ClientCount())
}

// TestHub_BroadcastMarshalFailureBumpsCounter (WR-05) verifies that a
// payload that fails json.Marshal increments MarshalFailureCount.
// Disciplined callers should never produce this — the counter exists
// so silent drops are observable in tests + ops.
func TestHub_BroadcastMarshalFailureBumpsCounter(t *testing.T) {
	hub := newTestHub(t)
	if got := hub.MarshalFailureCount(); got != 0 {
		t.Fatalf("initial counter: got %d, want 0", got)
	}
	// channels are not JSON-marshalable — guaranteed Marshal error.
	bad := make(chan int)
	hub.Broadcast("test:event", bad, "")
	if got := hub.MarshalFailureCount(); got != 1 {
		t.Errorf("after one bad broadcast: got %d, want 1", got)
	}
	// A second failure increments again — counter is cumulative.
	hub.Broadcast("test:event", bad, "")
	if got := hub.MarshalFailureCount(); got != 2 {
		t.Errorf("after two bad broadcasts: got %d, want 2", got)
	}
}

// TestHub_RejectsEmptyOrigin (WR-01 defense-in-depth) verifies that
// a request with no Origin header is rejected with 403, even though
// coder/websocket's authenticateOrigin would otherwise return nil for
// the empty-Origin case. This guards against a future bind-to-LAN
// regression: the localhost-bind posture in cmd/jasper makes empty-
// Origin unexploitable today, but the rejection here is the
// belt-and-suspenders if that posture ever changes.
func TestHub_RejectsEmptyOrigin(t *testing.T) {
	hub := newTestHub(t)
	srv := httptest.NewServer(hub)
	defer srv.Close()

	// Issue a non-WebSocket plain GET with no Origin header — exercises
	// the early-return before the upgrade attempt. The actual upgrade
	// would also fail, but this is the cheapest assertion.
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/?session_id=sid-noorigin", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	// Explicitly do NOT set Origin.
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for empty Origin, got %d", resp.StatusCode)
	}
}

// Verify that the hub satisfies http.Handler (ServeHTTP).
var _ http.Handler = (*wshub.Hub)(nil)
