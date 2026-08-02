package wshub

// RegisterFake registers a fake client so slow-client behavior can be tested
// without a real WebSocket. bufSize=0 makes the channel full from the start, so
// the broadcast's drop path fires immediately.
//
// LOAD-BEARING: the returned client has c.conn == nil. That is safe only while
// no production hot path touches c.conn. The day Broadcast inspects it — for a
// remote addr in a log line, say — this nil-derefs in the TEST path only, and
// passes CI until someone runs the slow-client test locally.
//
// If you need conn-touching coverage, stand up a real httptest server
// (hub_test.go's dialClient) or wire a stub conn here explicitly.
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
