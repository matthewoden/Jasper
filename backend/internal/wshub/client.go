package wshub

import (
	"context"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const sendBufferSize = 64

const (
	pingInterval = 30 * time.Second
	pingTimeout  = 5 * time.Second
	writeTimeout = 10 * time.Second
)

type client struct {
	sid       string
	conn      *websocket.Conn
	send      chan []byte
	closeSlow func()
	closeOnce sync.Once
}

func (h *Hub) writePump(ctx context.Context, c *client) {
	ping := time.NewTicker(pingInterval)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-c.send:
			if !ok {
				return
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
				return
			}
		}
	}
}

func (h *Hub) readPump(ctx context.Context, c *client) {
	for {
		_, _, err := c.conn.Read(ctx)
		if err != nil {
			return
		}
	}
}
