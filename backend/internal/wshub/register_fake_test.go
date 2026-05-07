package wshub

// RegisterFake is a test-only helper: registers a fake *client into
// the hub's registry so tests can verify SYNC-08 slow-client behavior
// WITHOUT spinning up a real WebSocket connection. bufSize=0 means
// the channel is full from the start, so the broadcast's default:
// branch fires immediately (drop path).
//
// closeSlow is invoked in a goroutine when the broadcast hits the
// default branch, mirroring the production code's
// `go c.closeSlow()` call.
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
