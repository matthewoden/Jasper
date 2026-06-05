package api

import (
	"context"
	"errors"

	"github.com/matthewoden/jasper/backend/internal/mcp"
)

// EventMcpGrantChanged mirrors wshub.EventMcpGrantChanged. We can't
// import wshub here because wshub already imports api (Amendment 2
// schema-drift sentinel in wshub/envelope.go), so a redeclared
// constant is the way we break the would-be cycle. The string MUST
// stay in sync with wshub.EventMcpGrantChanged and api/openapi.yaml's
// WSEnvelope.event enum — the WSEnvelopeEventMcpGrantChanged
// generated constant in openapi_gen.go is the source of truth used by
// hub_test.go assertions, so drift here would be caught by the
// schema-typed fixture sentinel.
const EventMcpGrantChanged = "mcp:grant_changed"

// GetMcpGrants implements GET /api/v1/mcp/grants. Returns every grant
// ordered by folder_path. Empty list (not 404) when no grants exist
// AND when MCP is disabled — the frontend rendering is identical
// (no indicators).
//
//nolint:revive // generated interface name
func (s *Server) GetMcpGrants(
	ctx context.Context,
	_ GetMcpGrantsRequestObject,
) (GetMcpGrantsResponseObject, error) {
	if s.mcpACL == nil {
		return GetMcpGrants200JSONResponse{Grants: []McpGrant{}}, nil
	}
	grants, err := s.mcpACL.List(ctx)
	if err != nil {
		s.log.Error("GetMcpGrants: list failed", "err", err)
		return nil, errors.New("could not list grants")
	}
	out := make([]McpGrant, 0, len(grants))
	for _, g := range grants {
		out = append(out, McpGrant{
			FolderPath: g.FolderPath,
			Level:      McpGrantLevel(g.Level),
			GrantedAt:  g.GrantedAt,
			GrantedVia: g.GrantedVia,
		})
	}
	return GetMcpGrants200JSONResponse{Grants: out}, nil
}

// PostMcpGrant implements POST /api/v1/mcp/grants. UPSERTs the grant
// at req.Body.FolderPath to req.Body.Level. Re-granting at a higher
// (or lower) level is an in-place tier change; the row count stays
// at one per canonical folder_path (D-13 + ACL.Set's ON CONFLICT
// clause).
//
// Validation errors from the ACL layer (".." paths, empty path,
// invalid level) map to 400 "invalid_path". The OpenAPI enum SHOULD
// catch invalid level values upstream, but we still propagate any
// ACL.Set error as 400 so the wire contract is uniform.
//
// granted_via defaults to "tree-menu" because the frontend
// (Plan 08-10) hasn't yet been wired to provide an X-Granted-Via
// telemetry header. When that lands the handler will pick up the
// header here and the four legal values become wizard /
// tree-context-menu / tree-dropdown-menu / tree-menu.
//
//nolint:revive // generated interface name
func (s *Server) PostMcpGrant(
	ctx context.Context,
	req PostMcpGrantRequestObject,
) (PostMcpGrantResponseObject, error) {
	if req.Body == nil {
		return PostMcpGrant400JSONResponse(newError("invalid_request", "request body required")), nil
	}
	if s.mcpACL == nil {
		return PostMcpGrant400JSONResponse(newError("mcp_disabled",
			"MCP server is disabled in config")), nil
	}

	const defaultVia = "tree-menu"
	g, err := s.mcpACL.Set(ctx, req.Body.FolderPath, mcp.GrantLevel(req.Body.Level), defaultVia)
	if err != nil {
		s.log.Warn("PostMcpGrant: set failed",
			"folder", req.Body.FolderPath, "level", req.Body.Level, "err", err)
		return PostMcpGrant400JSONResponse(newError("invalid_path", err.Error())), nil
	}

	if s.broadcaster != nil {
		s.broadcaster.Broadcast(EventMcpGrantChanged, map[string]any{
			"folder_path": g.FolderPath,
			"level":       int(g.Level),
			"action":      "set",
		}, "")
	}

	return PostMcpGrant200JSONResponse(McpGrant{
		FolderPath: g.FolderPath,
		Level:      McpGrantLevel(g.Level),
		GrantedAt:  g.GrantedAt,
		GrantedVia: g.GrantedVia,
	}), nil
}

// DeleteMcpGrant implements DELETE /api/v1/mcp/grants?path=<folder>.
// Idempotent — returns 204 even if the row didn't exist (ACL.Revoke
// returns nil for missing rows). Still broadcasts because the
// frontend's optimistic update may be out of sync with the server
// state; the broadcast lets every tab re-fetch and reconcile.
//
//nolint:revive // generated interface name
func (s *Server) DeleteMcpGrant(
	ctx context.Context,
	req DeleteMcpGrantRequestObject,
) (DeleteMcpGrantResponseObject, error) {
	if s.mcpACL == nil {
		return DeleteMcpGrant404JSONResponse(newError("mcp_disabled",
			"MCP server is disabled in config")), nil
	}
	if err := s.mcpACL.Revoke(ctx, req.Params.Path); err != nil {
		s.log.Error("DeleteMcpGrant: revoke failed",
			"path", req.Params.Path, "err", err)
		return nil, errors.New("could not revoke grant")
	}
	if s.broadcaster != nil {
		s.broadcaster.Broadcast(EventMcpGrantChanged, map[string]any{
			"folder_path": req.Params.Path,
			"action":      "revoked",
		}, "")
	}
	return DeleteMcpGrant204Response{}, nil
}
