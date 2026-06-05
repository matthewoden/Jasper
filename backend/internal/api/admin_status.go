package api

import (
	"context"
)

// GetAdminStatus implements GET /api/v1/admin/status. Returns the
// current migration runner state for the migration banner (UX-03).
//
// Voice-rule notes (UI-SPEC §Surface 1, threat T-02-03-03): the wire
// format never carries the SQL that failed or the absolute filesystem
// path of the live database — only the migration filename and the log
// file path (which the user already knows lives under their data dir).
//
// State enum mapping is 1:1 between migrate.State and
// api.MigrationStatusState because the underlying string constants
// match by design (status.go locks the string values).
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
	return out, nil
}
