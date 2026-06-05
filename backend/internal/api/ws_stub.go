package api

import "context"

// GetApiV1Ws is a strict-server stub. The actual /ws route is handled by
// wshub.Hub.ServeHTTP, which lifecycle.go registers AFTER api.HandlerFromMux
// so it wins under chi's last-registration-wins routing. This stub exists
// ONLY to satisfy the StrictServerInterface contract — it is unreachable in
// production. See Plan 04-01 RESEARCH.md Pitfall 8 and Plan 04-04 deviation.
//
//nolint:revive // generated interface name — must match StrictServerInterface.GetApiV1Ws
func (s *Server) GetApiV1Ws(ctx context.Context, req GetApiV1WsRequestObject) (GetApiV1WsResponseObject, error) {
	return GetApiV1Ws400Response{}, nil
}
