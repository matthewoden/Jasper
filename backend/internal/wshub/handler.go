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

// maxSessionIDLen caps the size of the session_id query param to
// reject header-bomb attacks (T-04-03). UUIDs are 36 chars; 128 is
// plenty for any legitimate value while rejecting the obvious abuse.
const maxSessionIDLen = 128

// ServeHTTP upgrades the request and runs read+write pumps until
// either side errors. Bound by chi at /api/v1/ws (Plan 04-04 wires
// this in lifecycle.go BEFORE api.HandlerFromMux so the manual route
// wins over the oapi-codegen-generated stub — Pitfall 8).
//
// Origin enforcement (T-04-01): AcceptOptions.OriginPatterns rejects
// upgrades whose Origin header doesn't match. coder/websocket v1.8.14
// REQUIRES this option (or InsecureSkipVerify) — without it the
// connection is rejected.
//
// WR-01 defense-in-depth: coder/websocket's authenticateOrigin returns
// nil when Origin is empty (e.g. native HTTP clients, curl, scripts),
// bypassing OriginPatterns. The localhost-bind posture in cmd/jasper
// (requireLoopbackBind) already mitigates this, but reject empty
// Origin here so a future bind-to-LAN regression cannot silently
// open the door.
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

	// Pitfall 1: client-as-authoritative session_id. The frontend
	// generates the UUID once per tab into sessionStorage and sends it
	// BOTH as ?session_id=<sid> on the WS upgrade AND as the
	// X-Session-ID header on every mutating HTTP request. The server
	// adopts whatever the client sent. If absent (curl probe, test
	// without the param), mint a fallback UUID so origin filtering
	// still works (the client just can't filter its own broadcasts).
	sid := r.URL.Query().Get("session_id")
	if sid == "" || len(sid) > maxSessionIDLen {
		// Empty OR too long → mint fallback. Length cap mitigates T-04-03.
		sid = uuid.NewString()
	}

	c := &client{
		sid:  sid,
		conn: conn,
		send: make(chan []byte, sendBufferSize),
		closeSlow: func() {
			// Best-effort close with a policy-violation status. On
			// failure (already-closed conn) the close is silent — fine.
			_ = conn.Close(websocket.StatusPolicyViolation,
				"connection too slow to keep up with messages")
		},
	}
	h.register(c)
	defer h.unregister(c)

	// SYNC-01: server confirms the session_id with a handshake message
	// BEFORE entering the read/write pumps so the client always knows
	// its sid before any mutation event arrives.
	//
	// Wire shape: Envelope{event: "session:assigned", origin_session_id: "",
	// payload: {"session_id": "<sid>"}}. The origin_session_id is empty
	// here because this is a server-originated (not mutation-originated) event.
	payloadBytes, _ := json.Marshal(map[string]string{"session_id": sid})
	handshakeCtx, hsCancel := context.WithTimeout(r.Context(), 5*time.Second)
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
	h.readPump(ctx, c) // blocks; returns on conn error or ctx cancel
}
