// Package api — Phase 6 strict-server stubs.
//
// This file is INTENTIONALLY temporary. It keeps `go build ./...` green
// between Plan 06-02 (declares the OpenAPI surface) and the plans that
// land the real handler bodies (06-05 tag CRUD + 06-11 backlinks/search).
// Once every method below has a real implementation elsewhere, this file
// is deleted in the same commit (Phase 2 + Phase 3 precedent — see
// handlers_stubs.go and handlers_phase3_stubs.go in git history).
package api

import (
	"context"
	"errors"
)

// GetTags implements GET /api/v1/tags (TAGS-03).
// stub: replaced by Plan 06-05 (tag CRUD handlers).
func (s *Server) GetTags(
	_ context.Context,
	_ GetTagsRequestObject,
) (GetTagsResponseObject, error) {
	return nil, errors.New("phase 6: not implemented yet") //nolint:staticcheck
}

// GetTagNotes implements GET /api/v1/tags/{name}/notes (TAGS-04).
// stub: replaced by Plan 06-05 (tag CRUD handlers).
func (s *Server) GetTagNotes(
	_ context.Context,
	_ GetTagNotesRequestObject,
) (GetTagNotesResponseObject, error) {
	return nil, errors.New("phase 6: not implemented yet") //nolint:staticcheck
}

// PutTag implements PUT /api/v1/tags/{name} (TAGS-06 / D-23 rename).
// stub: replaced by Plan 06-05 (tag CRUD handlers).
func (s *Server) PutTag(
	_ context.Context,
	_ PutTagRequestObject,
) (PutTagResponseObject, error) {
	return nil, errors.New("phase 6: not implemented yet") //nolint:staticcheck
}

// DeleteTag implements DELETE /api/v1/tags/{name} (TAGS-07 / D-24 bulk-remove).
// stub: replaced by Plan 06-05 (tag CRUD handlers).
func (s *Server) DeleteTag(
	_ context.Context,
	_ DeleteTagRequestObject,
) (DeleteTagResponseObject, error) {
	return nil, errors.New("phase 6: not implemented yet") //nolint:staticcheck
}

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
