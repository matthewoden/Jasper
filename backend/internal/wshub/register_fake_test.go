package wshub

// RegisterFake is a test-only helper: registers a fake *client into
// the hub's registry so tests can verify SYNC-08 slow-client behavior
// WITHOUT spinning up a real WebSocket connection. bufSize=0 means
// the channel is full from the start, so the broadcast's default:
// branch fires immediately (drop path).
//
// closeSlow is invoked in a goroutine when the broadcast hits the
// default branch, mirroring the production code's
// `go c.closeOnce.Do(c.closeSlow)` call.
//
// WR-08 — LOAD-BEARING WARNING:
//
// The returned *client has c.conn == nil. This is fine TODAY because
// only writePump touches c.conn and writePump is never started for
// fakes. Any future change that has Broadcast or any other production
// hot-path inspect c.conn (e.g. for logging the remote addr, surfacing
// connection metadata in metrics, etc.) WILL nil-deref in the test
// path only — silently passing in CI until a developer locally runs
// the slow-client test that reaches the hot-path.
//
// MUST NOT be called from any code path — production or test — that
// dereferences c.conn. If you need conn-touching coverage, either
// stand up a real httptest server (see hub_test.go dialClient) or
// teach this helper to wire a stub conn explicitly.
func RegisterFake(h *Hub, sid string, bufSize int, closeSlow func()) *client {
	c := &client{
		sid:       sid,
		send:      make(chan []byte, bufSize),
		closeSlow: closeSlow,
	}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	return c
}
