package api

import (
	"context"
)

// GetAdminStatus implements GET /api/v1/admin/status.
//
// Never puts the failing SQL or the live database's absolute path on the wire.
//
//nolint:revive // generated interface name (capital Id-style is upstream)
func (s *Server) GetAdminStatus(
	ctx context.Context,
	_ GetAdminStatusRequestObject,
) (GetAdminStatusResponseObject, error) {
	st := s.status.Status(ctx)
	out := GetAdminStatus200JSONResponse{
		State: MigrationStatusState(st.State),
	}
	if st.FailedMigration != "" {
		v := st.FailedMigration
		out.FailedMigration = &v
	}
	if st.LogsPath != "" {
		v := st.LogsPath
		out.LogsPath = &v
	}
	if st.NotesIndexed > 0 {
		v := st.NotesIndexed
		out.NotesIndexed = &v
	}
	if s.mcpStatusReader != nil {
		up, reason := s.mcpStatusReader.McpStatus()
		mcp := struct {
			Reason *string `json:"reason,omitempty"`
			Up     bool    `json:"up"`
		}{Up: up}
		if reason != "" {
			r := reason
			mcp.Reason = &r
		}
		out.Mcp = &mcp
	}
	return out, nil
}
