// Package api — Phase 6 strict-server stubs.
//
// This file is INTENTIONALLY temporary. It keeps `go build ./...` green
// between Plan 06-02 (declares the OpenAPI surface) and the plans that
// land the real handler bodies (06-05 tag CRUD + 06-11 backlinks/search).
// Once every method below has a real implementation elsewhere, this file
// is deleted in the same commit (Phase 2 + Phase 3 precedent — see
// handlers_stubs.go and handlers_phase3_stubs.go in git history).
//
// Plan 06-05 Task 4 removed: GetTags, GetTagNotes, PutTag, DeleteTag.
// Remaining stubs: GetNoteBacklinks, GetNotesSearchTitles.
package api

import (
	"context"
	"errors"
)

// GetNoteBacklinks implements GET /api/v1/notes/{id}/backlinks (LINKS-08 / D-27).
// stub: replaced by Plan 06-11 (backlinks + search-titles handlers).
func (s *Server) GetNoteBacklinks(
	_ context.Context,
	_ GetNoteBacklinksRequestObject,
) (GetNoteBacklinksResponseObject, error) {
	return nil, errors.New("phase 6: not implemented yet") //nolint:staticcheck
}

// GetNotesSearchTitles implements GET /api/v1/notes/search-titles (LINKS-06 / D-13).
// stub: replaced by Plan 06-11 (backlinks + search-titles handlers).
//
//nolint:revive // generated interface name
func (s *Server) GetNotesSearchTitles(
	_ context.Context,
	_ GetNotesSearchTitlesRequestObject,
) (GetNotesSearchTitlesResponseObject, error) {
	return nil, errors.New("phase 6: not implemented yet") //nolint:staticcheck
}
