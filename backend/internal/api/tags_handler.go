package api

// tags_handler.go — Plan 06-05 Task 4: real GetTags, GetTagNotes, PutTag,
// DeleteTag handlers replacing the four stubs in handlers_phase6_stubs.go.
//
// Design: handlers read/write tags via s.index (the notes.Index held by
// Server, NOT the nopIndex embedded in notes.Service). This decoupling
// lets tests use tagFakeIndex without needing a fully-wired notes.Service.
//
// FS rewriting (updating note files) is handled by notes.Service methods
// (RenameTagAcrossVault / DeleteTagAcrossVault) when the composition root
// (Plan 06-06) wires a real index into the Service. In this plan, the
// handler performs the SQL rename/delete and broadcasts the WS event; the
// file-level rewrite is the Service responsibility and is tested separately
// in service_test.go.

import (
	"context"
	"errors"
	"regexp"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// tagNameRE matches the D-22 charset: lowercase letters, digits, hyphens,
// underscores only. Used in all four tag handlers for validation (D-22
// defense-in-depth per T-06-02-01).
var tagNameRE = regexp.MustCompile(`^[a-z0-9_-]+$`)

func isValidTagNameStr(s string) bool { return tagNameRE.MatchString(s) }

// GetTags implements GET /api/v1/tags (TAGS-03).
// Returns alphabetical TagWithCount list; nil index returns empty list.
func (s *Server) GetTags(
	ctx context.Context,
	_ GetTagsRequestObject,
) (GetTagsResponseObject, error) {
	if s.index == nil {
		return GetTags200JSONResponse{Tags: []TagWithCount{}}, nil
	}
	rows, err := s.index.ListTags(ctx)
	if err != nil {
		s.log.Error("GetTags: list failed", "err", err)
		return nil, errors.New("could not load tags")
	}
	out := make([]TagWithCount, 0, len(rows))
	for _, r := range rows {
		out = append(out, TagWithCount{Name: r.Name, Count: r.Count})
	}
	return GetTags200JSONResponse{Tags: out}, nil
}

// GetTagNotes implements GET /api/v1/tags/{name}/notes (TAGS-04).
// Returns NoteSummary list for tag carriers; 404 when tag has no carriers.
func (s *Server) GetTagNotes(
	ctx context.Context,
	req GetTagNotesRequestObject,
) (GetTagNotesResponseObject, error) {
	name := string(req.Name)
	if s.index == nil {
		return GetTagNotes404JSONResponse(newError("not_found", "tag not found")), nil
	}
	carriers, err := s.index.NotesByTag(ctx, name)
	if err != nil {
		s.log.Error("GetTagNotes: query failed", "tag", name, "err", err)
		return nil, errors.New("could not load tag notes")
	}
	if len(carriers) == 0 {
		return GetTagNotes404JSONResponse(newError("not_found", "tag not found")), nil
	}
	out := make([]NoteSummary, 0, len(carriers))
	for _, sm := range carriers {
		out = append(out, NoteSummary{
			Id:        openapi_types.UUID(sm.ID),
			Path:      sm.Path,
			Title:     sm.Title,
			UpdatedAt: sm.UpdatedAt,
		})
	}
	return GetTagNotes200JSONResponse{Notes: out}, nil
}

// PutTag implements PUT /api/v1/tags/{name} (TAGS-06 / D-23 rename).
//
// Validates D-22 charset for both old and new names, then calls
// s.index.RenameTag() for the SQL-level rename and broadcasts the
// tags:rewritten WS event (D-34) with origin_session_id for self-suppression
// (D-35).
//
// Error mapping:
//   - notes.ErrTagNotFound    → 404 not_found
//   - notes.ErrTagCollision   → 409 conflict
//   - notes.ErrInvalidTagName → 400 invalid_request
func (s *Server) PutTag(
	ctx context.Context,
	req PutTagRequestObject,
) (PutTagResponseObject, error) {
	if req.Body == nil {
		return PutTag400JSONResponse(newError("invalid_request", "request body is required")), nil
	}
	oldName := string(req.Name)
	newName := req.Body.NewName

	// D-22 charset validation (defense-in-depth; also enforced by index layer).
	if !isValidTagNameStr(oldName) {
		return PutTag400JSONResponse(newError("invalid_request", "tag name contains invalid characters (allowed: [a-z0-9_-]+)")), nil
	}
	if !isValidTagNameStr(newName) {
		return PutTag400JSONResponse(newError("invalid_request", "new_name contains invalid characters (allowed: [a-z0-9_-]+)")), nil
	}

	if s.index == nil {
		return PutTag404JSONResponse(newError("not_found", "tag not found")), nil
	}

	touchedIDs, err := s.index.RenameTag(ctx, oldName, newName)
	if err != nil {
		switch {
		case errors.Is(err, notes.ErrTagNotFound):
			return PutTag404JSONResponse(newError("not_found", "tag not found")), nil
		case errors.Is(err, notes.ErrTagCollision):
			return PutTag409JSONResponse(newError("conflict", "a tag with this name already exists")), nil
		case errors.Is(err, notes.ErrInvalidTagName):
			return PutTag400JSONResponse(newError("invalid_request", err.Error())), nil
		default:
			s.log.Error("PutTag: rename failed", "old", oldName, "new", newName, "err", err)
			return nil, errors.New("could not rename tag")
		}
	}

	// Broadcast tags:rewritten with origin_session_id for D-35 self-suppression.
	if s.broadcaster != nil {
		sessionID := notes.SessionIDFromContext(ctx)
		ids := make([]string, len(touchedIDs))
		for i, id := range touchedIDs {
			ids[i] = id.String()
		}
		s.broadcaster.Broadcast(notes.EventTagsRewritten, map[string]any{
			"old_name":         oldName,
			"new_name":         newName,
			"touched_note_ids": ids,
		}, sessionID)
	}

	// Build response with touched_note_ids as openapi_types.UUID slice.
	touchedUUIDs := make([]openapi_types.UUID, len(touchedIDs))
	for i, id := range touchedIDs {
		touchedUUIDs[i] = openapi_types.UUID(id)
	}
	return PutTag200JSONResponse(TagRenameResponse{
		OldName:        oldName,
		NewName:        newName,
		TouchedNoteIds: touchedUUIDs,
	}), nil
}

// DeleteTag implements DELETE /api/v1/tags/{name} (TAGS-07 / D-24 bulk-remove).
//
// Calls s.index.DeleteTag() for the SQL-level delete and broadcasts the
// tags:rewritten WS event (D-34) with new_name=null.
//
// Error mapping:
//   - notes.ErrTagNotFound → 404 not_found
func (s *Server) DeleteTag(
	ctx context.Context,
	req DeleteTagRequestObject,
) (DeleteTagResponseObject, error) {
	name := string(req.Name)

	if s.index == nil {
		return DeleteTag404JSONResponse(newError("not_found", "tag not found")), nil
	}

	touchedIDs, err := s.index.DeleteTag(ctx, name)
	if err != nil {
		switch {
		case errors.Is(err, notes.ErrTagNotFound):
			return DeleteTag404JSONResponse(newError("not_found", "tag not found")), nil
		default:
			s.log.Error("DeleteTag: delete failed", "name", name, "err", err)
			return nil, errors.New("could not delete tag")
		}
	}

	// Broadcast tags:rewritten with new_name=null per D-24.
	if s.broadcaster != nil {
		sessionID := notes.SessionIDFromContext(ctx)
		ids := make([]string, len(touchedIDs))
		for i, id := range touchedIDs {
			ids[i] = id.String()
		}
		s.broadcaster.Broadcast(notes.EventTagsRewritten, map[string]any{
			"old_name":         name,
			"new_name":         nil,
			"touched_note_ids": ids,
		}, sessionID)
	}

	touchedUUIDs := make([]openapi_types.UUID, len(touchedIDs))
	for i, id := range touchedIDs {
		touchedUUIDs[i] = openapi_types.UUID(id)
	}
	return DeleteTag200JSONResponse(TagDeleteResponse{
		OldName:        name,
		TouchedNoteIds: touchedUUIDs,
	}), nil
}
