package wshub

import (
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// Compile-time assertion: Hub satisfies the notes.Broadcaster port.
// The assertion lives here so the generated-types boundary is verified
// in the concrete implementation file (Plan 04-04 — Pitfall 6).
var _ notes.Broadcaster = (*Hub)(nil)

// Hub is the registry of connected WebSocket clients and the broadcast
// fan-out point. Per-client outbound buffering + non-blocking sends
// satisfy SYNC-08 (slow clients dropped without blocking the broadcast
// goroutine).
//
// Concurrency:
//   - mu (RWMutex) guards the clients map.
//   - Broadcast holds RLock (read-only iteration of the map).
//   - register / unregister hold Lock (mutate the map).
//   - closeSlow is invoked in a goroutine so the broadcast loop never
//     waits on the unregister Lock (Pitfall 6 in RESEARCH.md).
//
// ClientCount is a small convenience getter exposed for tests
// (TestHub_DisconnectCleanup). It is cheap enough to leave in production.
type Hub struct {
	log     *slog.Logger
	mu      sync.RWMutex
	clients map[*client]struct{}
}

// New constructs an empty Hub. Logger fallback mirrors notes.NewService
// (backend/internal/notes/service.go:46-59).
func New(log *slog.Logger) *Hub {
	if log == nil {
		log = slog.Default()
	}
	return &Hub{
		log:     log,
		clients: make(map[*client]struct{}),
	}
}

// Broadcast emits eventType with payload to every connected client
// EXCEPT the one whose session_id matches originSessionID. Non-blocking:
// slow clients (full send chan) are dropped via closeSlow.
//
// Plan 04-04 declares notes.Broadcaster matching this signature, so the
// hub satisfies the port without further work in this plan. The signature
// below is FROZEN.
//
// SECURITY (T-04-04): payload MUST be a metadata-only shape. Note content
// MUST NOT appear in any payload. The notes.Service caller honors this
// (Plan 04-04).
func (h *Hub) Broadcast(eventType string, payload any, originSessionID string) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		h.log.Error("hub.Broadcast: marshal payload", "event", eventType, "err", err)
		return
	}
	env, err := json.Marshal(Envelope{
		Event:           eventType,
		OriginSessionID: originSessionID,
		Payload:         payloadBytes,
	})
	if err != nil {
		h.log.Error("hub.Broadcast: marshal envelope", "event", eventType, "err", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if c.sid == originSessionID {
			continue // SYNC-03 origin filter
		}
		select {
		case c.send <- env:
		default:
			// SYNC-08: slow client; drop without blocking the broadcast
			// goroutine. closeSlow runs in a goroutine so it can acquire
			// the unregister Lock without deadlocking on our held RLock
			// (Pitfall 6). WR-03: closeOnce gates the call so a 100-event
			// burst does not spawn 100 redundant closeSlow goroutines on
			// the same already-closing connection.
			go c.closeOnce.Do(c.closeSlow)
		}
	}
}

// register adds c to the registry. Holds Lock.
func (h *Hub) register(c *client) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

// unregister removes c from the registry and closes its send channel.
// Holds Lock. Idempotent — safe to call from defers + closeSlow paths.
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
