package api

import "context"

// GetFile is a strict-server stub. The live GET /api/v1/files route is
// ServeFile, registered after api.HandlerFromMux so it wins under chi's
// last-registration-wins routing — the same arrangement /ws uses.
//
// The hand-mounted handler exists because the generated response type can set
// only Content-Type and Content-Length, and this route needs neither of the
// values it hard-codes: it serves sniffed media types (with an explicit
// image/svg+xml override, without which browsers refuse an SVG in <img>) and
// the raw-file security headers.
//
// Previously this stub was a full second implementation of the path pipeline —
// dead code that looked live, and that had to be found and fixed again every
// time the live one changed.
//
//nolint:revive // generated interface name — must match StrictServerInterface.GetFile
func (s *Server) GetFile(_ context.Context, _ GetFileRequestObject) (GetFileResponseObject, error) {
	return GetFile400JSONResponse(newError("unreachable",
		"GET /files is served by the hand-mounted handler; this stub satisfies the generated interface")), nil
}
