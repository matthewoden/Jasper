package api

import "context"

// GetApiV1Ws is a strict-server stub. The actual /ws route is intercepted
// in app/lifecycle.go by wshub.Hub.ServeHTTP BEFORE api.HandlerFromMux,
// so this handler is unreachable in production. It exists ONLY to satisfy
// the StrictServerInterface contract. See Plan 04-01 RESEARCH.md Pitfall 8.
//
//nolint:revive // generated interface name — must match StrictServerInterface.GetApiV1Ws
func (s *Server) GetApiV1Ws(ctx context.Context, req GetApiV1WsRequestObject) (GetApiV1WsResponseObject, error) {
	// Returning the 400 response object — this code path should never
	// execute because lifecycle.go mounts wshub.Hub.ServeHTTP at /ws
	// before api.HandlerFromMux runs. Plan 04-04 wires that mount.
	return GetApiV1Ws400Response{}, nil
}
