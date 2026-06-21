package wshub

import (
	"encoding/json"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

var _ notes.Broadcaster = (*Hub)(nil)

// Hub is the registry of connected WebSocket clients and the broadcast
// fan-out point. Per-client outbound buffering + non-blocking sends
// ensure slow clients are dropped without blocking the broadcast goroutine.
//
// Concurrency:
//   - mu (RWMutex) guards the clients map.
//   - Broadcast holds RLock (read-only iteration).
//   - register / unregister hold Lock (mutate the map).
//   - closeSlow is invoked in a goroutine so the broadcast loop never
//     waits on the unregister Lock.
//
// marshalFailures (atomic) counts broadcast attempts dropped because
// json.Marshal returned an error on the payload (e.g. a chan embedded,
// cyclic struct). MarshalFailureCount() exposes the value for tests.
type Hub struct {
	log             *slog.Logger
	originPatterns  []string
	mu              sync.RWMutex
	clients         map[*client]struct{}
	marshalFailures uint64
}

// WsOriginPatterns derives the glob host:port patterns that websocket.Accept
// expects from a listen address. The format ("localhost:*") differs from the
// full-URL form used by the CSRF middleware ("http://localhost:6683") — do not
// share slices between them. For 0.0.0.0 all-interfaces binds, returns a
// wildcard port pattern "*:PORT" so any host on the configured port is accepted.
func WsOriginPatterns(listenAddr string) []string {
	host, port, err := net.SplitHostPort(listenAddr)
	if err != nil {
		return []string{"localhost:*", "127.0.0.1:*"}
	}
	if host == "0.0.0.0" {
		return []string{
			"localhost:" + port,
			"127.0.0.1:" + port,
			"[::1]:" + port,
			"*:" + port,
		}
	}
	return []string{
		"localhost:" + port,
		"127.0.0.1:" + port,
		"[::1]:" + port,
	}
}

// New constructs an empty Hub with origin patterns derived from listenAddr.
// Pass the resolved listen address (e.g. "127.0.0.1:6683" or "0.0.0.0:6683")
// so the Hub's WebSocket upgrade enforcement matches the HTTP bind posture.
// Logger fallback mirrors notes.NewService (backend/internal/notes/service.go).
func New(log *slog.Logger, listenAddr string) *Hub {
	if log == nil {
		log = slog.Default()
	}
	return &Hub{
		log:            log,
		originPatterns: WsOriginPatterns(listenAddr),
		clients:        make(map[*client]struct{}),
	}
}

// NewWithOrigins constructs a Hub with an explicit set of origin patterns.
// Prefer New() for production use; NewWithOrigins is provided for tests that
// need precise pattern control.
func NewWithOrigins(log *slog.Logger, originPatterns []string) *Hub {
	if log == nil {
		log = slog.Default()
	}
	return &Hub{
		log:            log,
		originPatterns: originPatterns,
		clients:        make(map[*client]struct{}),
	}
}

// Broadcast emits eventType with payload to every connected client
// EXCEPT the one whose session_id matches originSessionID. Non-blocking:
// slow clients (full send chan) are dropped via closeSlow.
//
// SECURITY: payload MUST be a metadata-only shape. Note content MUST NOT
// appear in any payload. The notes.Service caller is responsible for
// honoring this constraint.
func (h *Hub) Broadcast(eventType string, payload any, originSessionID string) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		atomic.AddUint64(&h.marshalFailures, 1)
		h.log.Error("hub.Broadcast: marshal payload", "event", eventType, "err", err)
		return
	}
	env, err := json.Marshal(Envelope{
		Event:           eventType,
		OriginSessionID: originSessionID,
		Payload:         payloadBytes,
	})
	if err != nil {
		atomic.AddUint64(&h.marshalFailures, 1)
		h.log.Error("hub.Broadcast: marshal envelope", "event", eventType, "err", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if c.sid == originSessionID {
			continue
		}
		select {
		case c.send <- env:
		default:

			go c.closeOnce.Do(c.closeSlow)
		}
	}
}

func (h *Hub) register(c *client) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) unregister(c *client) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
	}
	h.mu.Unlock()
}

// ClientCount returns the number of currently registered clients.
// Test-only convenience (used by TestHub_DisconnectCleanup); cheap
// enough to leave in production.
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	n := len(h.clients)
	h.mu.RUnlock()
	return n
}

// MarshalFailureCount returns the cumulative number of Broadcast
// calls dropped because json.Marshal returned an error on the
// payload or envelope. Atomic read; safe for concurrent callers.
// Used by tests to assert that disciplined callers do not produce
// marshal failures.
func (h *Hub) MarshalFailureCount() uint64 {
	return atomic.LoadUint64(&h.marshalFailures)
}
