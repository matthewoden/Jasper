package api

import "context"

// GetApiV1Ws is a strict-server stub. The actual /ws route is handled by
// wshub.Hub.ServeHTTP, registered after api.HandlerFromMux so it wins under
// chi's last-registration-wins routing. This stub exists only to satisfy the
// StrictServerInterface contract and is unreachable in production.
//
//nolint:revive // generated interface name — must match StrictServerInterface.GetApiV1Ws
func (s *Server) GetApiV1Ws(ctx context.Context, req GetApiV1WsRequestObject) (GetApiV1WsResponseObject, error) {
	return GetApiV1Ws400Response{}, nil
}
