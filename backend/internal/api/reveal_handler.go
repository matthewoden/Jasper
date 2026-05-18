package api

import "context"

// PostReveal is a Phase 8 Plan 08-01 placeholder that satisfies the
// generated StrictServerInterface so the build stays green while
// Waves 2-4 land. The real implementation lives in Plan 08-05
// (SHARE-01, D-26, D-27) and will REPLACE this file's body — the
// signature and file name are locked here so the downstream plan
// is a drop-in rewrite.
//
// Deviation note (Plan 08-01 Rule 3): the plan claimed Go's type
// system only enforces interface compliance at the assertion site,
// so adding handler stubs would be unnecessary. In practice
// app.go/lifecycle.go pass *Server to api.NewStrictHandler (which
// takes a StrictServerInterface), which DOES trigger the check at
// the call site. A 501 placeholder body keeps the build green; the
// production behavior lands in 08-05.
//
//nolint:revive // generated interface name
func (s *Server) PostReveal(
	_ context.Context,
	_ PostRevealRequestObject,
) (PostRevealResponseObject, error) {
	return PostReveal501JSONResponse(newError("not_implemented",
		"reveal handler not yet implemented (Phase 8 Plan 08-05)")), nil
}
