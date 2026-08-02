package api

import "context"

// GetFile is an unreachable strict-server stub; ServeFile is the live route.
// Keep it empty — it was once a second copy of the path pipeline, dead code
// that looked live and had to be re-fixed every time the real one changed.
//
//nolint:revive // generated interface name — must match StrictServerInterface.GetFile
func (s *Server) GetFile(_ context.Context, _ GetFileRequestObject) (GetFileResponseObject, error) {
	return GetFile400JSONResponse(newError("unreachable",
		"GET /files is served by the hand-mounted handler; this stub satisfies the generated interface")), nil
}
