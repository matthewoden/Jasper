package wshub

import (
	"context"
	"time"

	"github.com/coder/websocket"
)

// sendBufferSize is the per-client outbound buffer cap (SYNC-08).
// When a client's chan fills, the broadcast loop drops to the
// default: branch and the client is closed via closeSlow. 64 matches
// REQUIREMENTS.md SYNC-08 verbatim.
const sendBufferSize = 64

// pingInterval matches the coder/websocket chat example. Browsers
// detect socket close in milliseconds via TCP RST; the server-side
// ping is for half-open NAT detection.
const (
	pingInterval = 30 * time.Second
	pingTimeout  = 5 * time.Second
	writeTimeout = 10 * time.Second
)

// client owns one WebSocket connection. Created on Accept, registered
// with the Hub, drained by writePump, fed by Broadcast.
type client struct {
	sid       string          // adopted from ?session_id=<sid> query param (Pitfall 1)
	conn      *websocket.Conn // owned for the connection's lifetime
	send      chan []byte     // pre-encoded envelope bytes; cap = sendBufferSize
	closeSlow func()          // invoked when send chan fills (drop path)
}

// writePump drains c.send and writes each envelope as a single text
// message. Also fires a ping on a 30s ticker for half-open detection.
// Returns when ctx is done OR the conn errors.
func (h *Hub) writePump(ctx context.Context, c *client) {
	ping := time.NewTicker(pingInterval)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-c.send:
			if !ok {
				return // unregister closed the chan
			}
			wctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := c.conn.Write(wctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				return
			}
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, pingTimeout)
			err := c.conn.Ping(pctx)
			cancel()
			if err != nil {
				return // socket dead; readPump will also exit
			}
		}
	}
}

// readPump drains reads from the client and discards them. The v1
// protocol is server-broadcast-only; clients never originate
// payloads. Reads are still drained so coder/websocket can process
// pongs and detect close-frames.
func (h *Hub) readPump(ctx context.Context, c *client) {
	for {
		_, _, err := c.conn.Read(ctx)
		if err != nil {
			return
		}
	}
}
