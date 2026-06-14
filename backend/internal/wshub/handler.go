package wshub

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"
)

const maxSessionIDLen = 128

// ServeHTTP upgrades the request and runs read+write pumps until
// either side errors. Bound by chi at /api/v1/ws; the manual route
// is registered BEFORE api.HandlerFromMux so it wins over the
// oapi-codegen-generated stub.
//
// Origin enforcement: AcceptOptions.OriginPatterns rejects upgrades
// whose Origin header doesn't match. coder/websocket REQUIRES this
// option (or InsecureSkipVerify) — without it the connection is rejected.
//
// Defense-in-depth: coder/websocket's authenticateOrigin returns nil when
// Origin is empty (e.g. curl, scripts), bypassing OriginPatterns. The
// localhost-bind posture already mitigates this, but we reject empty Origin
// here so a future bind-to-LAN regression cannot silently open the door.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") == "" {
		h.log.Warn("hub: rejecting upgrade with empty Origin header (WR-01)",
			"remote_addr", r.RemoteAddr)
		http.Error(w, "missing Origin header", http.StatusForbidden)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"localhost:*", "127.0.0.1:*"},
	})
	if err != nil {
		h.log.Warn("hub: accept failed", "err", err)
		return
	}
	defer conn.CloseNow() //nolint:errcheck

	sid := r.URL.Query().Get("session_id")
	if sid == "" || len(sid) > maxSessionIDLen {
		sid = uuid.NewString()
	}

	c := &client{
		sid:  sid,
		conn: conn,
		send: make(chan []byte, sendBufferSize),
		closeSlow: func() {
			_ = conn.Close(websocket.StatusPolicyViolation,
				"connection too slow to keep up with messages")
		},
	}
	h.register(c)
	defer h.unregister(c)

	payloadBytes, _ := json.Marshal(map[string]string{"session_id": sid})
	handshakeCtx, hsCancel := context.WithTimeout(context.Background(), 1*time.Second)
	err = wsjson.Write(handshakeCtx, conn, Envelope{
		Event:           EventSessionAssigned,
		OriginSessionID: "",
		Payload:         payloadBytes,
	})
	hsCancel()
	if err != nil {
		h.log.Warn("hub: handshake write failed", "err", err)
		return
	}

	ctx, cancelAll := context.WithCancel(r.Context())
	defer cancelAll()

	go h.writePump(ctx, c)
	h.readPump(ctx, c)
}
