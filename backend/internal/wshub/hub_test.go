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

	var env apigen.WSEnvelope
	readCtx, readCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer readCancel()
	if err := wsjson.Read(readCtx, conn, &env); err != nil {
		t.Fatalf("dialClient: read handshake: %v", err)
	}
	if string(env.Event) != wshub.EventSessionAssigned {
		t.Fatalf("dialClient: expected event %q, got %q", wshub.EventSessionAssigned, env.Event)
	}

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

	if sidA != "sid-A" {
		t.Fatalf("sidA mismatch: %q", sidA)
	}
	if sidB != "sid-B" {
		t.Fatalf("sidB mismatch: %q", sidB)
	}

	hub.Broadcast(wshub.EventNoteUpdated, map[string]string{"id": "n1"}, sidA)

	recvCtx, recvCancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer recvCancel()
	var envB apigen.WSEnvelope
	if err := wsjson.Read(recvCtx, connB, &envB); err != nil {
		t.Fatalf("sidB: expected broadcast, got error: %v", err)
	}
	if string(envB.Event) != wshub.EventNoteUpdated {
		t.Errorf("sidB event: got %q, want %q", envB.Event, wshub.EventNoteUpdated)
	}

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

	wshub.RegisterFake(hub, "slow-client", 0, closeSlow)

	start := time.Now()
	hub.Broadcast(wshub.EventNoteUpdated, map[string]string{"id": "n1"}, "other-origin")
	elapsed := time.Since(start)

	if elapsed > 10*time.Millisecond {
		t.Errorf("Broadcast blocked for %v; expected < 10ms (slow-client drop must be non-blocking)", elapsed)
	}

	select {
	case <-dropped:

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

	conn.Close(websocket.StatusNormalClosure, "bye") //nolint:errcheck

	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if hub.ClientCount() == 0 {
			return
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

	bad := make(chan int)
	hub.Broadcast("test:event", bad, "")
	if got := hub.MarshalFailureCount(); got != 1 {
		t.Errorf("after one bad broadcast: got %d, want 1", got)
	}

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

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/?session_id=sid-noorigin", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for empty Origin, got %d", resp.StatusCode)
	}
}

var _ http.Handler = (*wshub.Hub)(nil)
