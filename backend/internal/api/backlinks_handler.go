package api

// backlinks_handler.go — Plan 06-11 Task 1: GetNoteBacklinks handler.
//
// Replaces the GetNoteBacklinks stub in handlers_phase6_stubs.go.
//
// Note existence check strategy:
//   1. Parse and validate the id parameter as a UUID (→ 400 on failure).
//   2. Call index.List() and scan for the UUID to check existence (→ 404 if absent).
//   3. Call index.GetBacklinks(ctx, id) to get the resolved backlinks.
//
// The List()-based existence check is O(n) in the number of notes but is the
// only approach available without a per-UUID lookup in the Index interface.
// For a single-user self-hosted vault with <5,000 notes, this is fast enough
// (D-13 NFR). A dedicated LookupByID method can be added in a later phase.

import (
	"context"
	"errors"

	openapi_types "github.com/oapi-codegen/runtime/types"
)

// GetNoteBacklinks implements GET /api/v1/notes/{id}/backlinks (LINKS-08 / D-27).
//
// Returns the resolved backlinks for the given note (source rows, sorted by
// source mtime DESC per D-28). Pending rows (target_id IS NULL) are excluded
// per D-32. When the note has no inbound links the response is an empty array,
// not null.
//
// T-06-11-01 mitigation: the server builds the excerpt HTML server-side;
// the client MUST pass it through sanitize.ts (DOMPurify). This handler
// does not sanitize (single-user, localhost-only) but the contract is
// documented and enforced via the client-side sanitize.ts wrapper.
//
//nolint:revive // generated interface name
func (s *Server) GetNoteBacklinks(
	ctx context.Context,
	req GetNoteBacklinksRequestObject,
) (GetNoteBacklinksResponseObject, error) {
	// Step 1: note UUID is pre-validated by oapi-codegen (NoteId is openapi_types.UUID).
	// However, the strict-server passes a NoteId which is already a uuid.UUID — if the
	// path param was non-UUID, the router returns 400 before reaching this handler.
	id := req.Id // openapi_types.UUID — already validated

	// Step 2: fast-path: nil index → empty backlinks (Phase 1 compatibility).
	if s.index == nil {
		return GetNoteBacklinks200JSONResponse{Backlinks: []BacklinkRow{}}, nil
	}

	// Step 3: existence check via index.List().
	// We scan the list for the target UUID to return 404 when the note is not indexed.
	summaries, err := s.index.List(ctx)
	if err != nil {
		s.log.Error("GetNoteBacklinks: list failed", "id", openapi_types.UUID(id).String(), "err", err)
		return nil, errors.New("could not check note existence")
	}
	found := false
	for _, sm := range summaries {
		if sm.ID == id {
			found = true
			break
		}
	}
	if !found {
		return GetNoteBacklinks404JSONResponse(newError("not_found", "note not found")), nil
	}

	// Step 4: fetch resolved backlinks from the index.
	rows, err := s.index.GetBacklinks(ctx, id)
	if err != nil {
		s.log.Error("GetNoteBacklinks: index error", "id", openapi_types.UUID(id).String(), "err", err)
		return nil, errors.New("could not load backlinks")
	}

	// Step 5: map index.BacklinkRow → api.BacklinkRow (wire type).
	out := make([]BacklinkRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, BacklinkRow{
			SourceId:    openapi_types.UUID(r.SourceID),
			SourceTitle: r.SourceTitle,
			SourcePath:  r.SourcePath,
			Excerpt:     r.Excerpt,
			Count:       r.Count,
		})
	}
	return GetNoteBacklinks200JSONResponse{Backlinks: out}, nil
}
