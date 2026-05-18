package api

import "context"

// Phase 8 Plan 08-01 placeholders for the /mcp/grants surface
// (MCP-01, D-17). The real implementation lives in Plan 08-08
// and will REPLACE this file's bodies — the signatures and file
// name are locked here so the downstream plan is a drop-in rewrite.
//
// Deviation note (Plan 08-01 Rule 3): see reveal_handler.go for
// the explanation of why these stubs exist despite the plan
// asking for no stubs.

//nolint:revive // generated interface name
func (s *Server) GetMcpGrants(
	_ context.Context,
	_ GetMcpGrantsRequestObject,
) (GetMcpGrantsResponseObject, error) {
	// Empty grants list — frontend renders no indicators until 08-08
	// wires the real ACL store.
	return GetMcpGrants200JSONResponse{Grants: []McpGrant{}}, nil
}

//nolint:revive // generated interface name
func (s *Server) PostMcpGrant(
	_ context.Context,
	_ PostMcpGrantRequestObject,
) (PostMcpGrantResponseObject, error) {
	return PostMcpGrant400JSONResponse(newError("not_implemented",
		"mcp grant handler not yet implemented (Phase 8 Plan 08-08)")), nil
}

//nolint:revive // generated interface name
func (s *Server) DeleteMcpGrant(
	_ context.Context,
	_ DeleteMcpGrantRequestObject,
) (DeleteMcpGrantResponseObject, error) {
	return DeleteMcpGrant404JSONResponse(newError("not_implemented",
		"mcp grant handler not yet implemented (Phase 8 Plan 08-08)")), nil
}
