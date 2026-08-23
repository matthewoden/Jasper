package api

import (
	"context"
	"errors"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/matthewoden/jasper/backend/internal/bookmarks"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// GetBookmarks implements GET /api/v1/bookmarks.
//
// Reads the whole bookmarks document directly via bookmarks.Load (not
// through s.bookmarks, which only exposes mutation methods) so the
// auto-pruned folders + bookmarks are always served fresh.
//
//nolint:revive // generated interface name
func (s *Server) GetBookmarks(
	ctx context.Context,
	_ GetBookmarksRequestObject,
) (GetBookmarksResponseObject, error) {
	// s.notes can be nil (Server's documented graceful-degradation
	// contract, exercised by NewServerWithIndex(nil, ...) in tests
	// elsewhere in this package) — s.notes.Registry() would panic on a nil
	// receiver reading a field. bookmarks.Load itself already treats a nil
	// registry as "nothing resolves"; pass nil explicitly rather than
	// dereferencing s.notes.
	var registry *notes.Registry
	if s.notes != nil {
		registry = s.notes.Registry()
	}
	doc, err := bookmarks.Load(s.dataDir, registry, s.log)
	if err != nil {
		s.log.Error("GetBookmarks: domain error", "err", err)
		return nil, errors.New("could not load bookmarks")
	}
	return GetBookmarks200JSONResponse(s.toWireDocument(doc)), nil
}

// PostBookmark implements POST /api/v1/bookmarks.
//
//nolint:revive // generated interface name
func (s *Server) PostBookmark(
	ctx context.Context,
	req PostBookmarkRequestObject,
) (PostBookmarkResponseObject, error) {
	defer s.trackWrite()()
	if req.Body == nil {
		return PostBookmark400JSONResponse(newError("invalid_request", "request body required")), nil
	}

	bm, err := s.bookmarks.Add(ctx, uuid.UUID(req.Body.NoteId), uuidPtrToStringPtr(req.Body.FolderId))
	if err != nil {
		s.log.Error(
			"PostBookmark: domain error",
			"note_id", req.Body.NoteId.String(),
			"err", err,
		)
		switch {
		case errors.Is(err, bookmarks.ErrNoteNotFound):
			return PostBookmark404JSONResponse(newError("not_found", "note not found")), nil
		case errors.Is(err, bookmarks.ErrFolderNotFound):
			return PostBookmark400JSONResponse(newError("invalid_request", "folder not found")), nil
		}
		return nil, errors.New("could not create bookmark")
	}

	wire, err := toWireBookmark(bm)
	if err != nil {
		s.log.Error("PostBookmark: could not encode response", "err", err)
		return nil, errors.New("could not create bookmark")
	}
	return PostBookmark201JSONResponse(wire), nil
}

// DeleteBookmark implements DELETE /api/v1/bookmarks/{id}.
//
//nolint:revive // generated interface name
func (s *Server) DeleteBookmark(
	ctx context.Context,
	req DeleteBookmarkRequestObject,
) (DeleteBookmarkResponseObject, error) {
	defer s.trackWrite()()
	id := openapi_types.UUID(req.Id).String()
	if err := s.bookmarks.Remove(ctx, id); err != nil {
		s.log.Error("DeleteBookmark: domain error", "id", id, "err", err)
		if errors.Is(err, bookmarks.ErrNotFound) {
			return DeleteBookmark404JSONResponse(newError("not_found", "bookmark not found")), nil
		}
		return nil, errors.New("could not delete bookmark")
	}
	return DeleteBookmark204Response{}, nil
}

// MoveBookmark implements POST /api/v1/bookmarks/{id}/folder.
//
//nolint:revive // generated interface name
func (s *Server) MoveBookmark(
	ctx context.Context,
	req MoveBookmarkRequestObject,
) (MoveBookmarkResponseObject, error) {
	defer s.trackWrite()()
	if req.Body == nil {
		return MoveBookmark400JSONResponse(newError("invalid_request", "request body required")), nil
	}

	id := openapi_types.UUID(req.Id).String()
	folderID := uuidPtrToStringPtr(req.Body.FolderId)
	if err := s.bookmarks.MoveToFolder(ctx, id, folderID); err != nil {
		s.log.Error("MoveBookmark: domain error", "id", id, "err", err)
		switch {
		case errors.Is(err, bookmarks.ErrNotFound):
			return MoveBookmark404JSONResponse(newError("not_found", "bookmark not found")), nil
		case errors.Is(err, bookmarks.ErrFolderNotFound):
			return MoveBookmark400JSONResponse(newError("invalid_request", "folder not found")), nil
		}
		return nil, errors.New("could not move bookmark")
	}

	return MoveBookmark200JSONResponse{
		Id:       req.Id,
		FolderId: req.Body.FolderId,
	}, nil
}

// ReorderBookmarks implements POST /api/v1/bookmarks/reorder.
//
//nolint:revive // generated interface name
func (s *Server) ReorderBookmarks(
	ctx context.Context,
	req ReorderBookmarksRequestObject,
) (ReorderBookmarksResponseObject, error) {
	defer s.trackWrite()()
	if req.Body == nil {
		return ReorderBookmarks400JSONResponse(newError("invalid_request", "request body required")), nil
	}

	folderID := uuidPtrToStringPtr(req.Body.FolderId)
	orderedIDs := make([]string, 0, len(req.Body.OrderedIds))
	for _, id := range req.Body.OrderedIds {
		orderedIDs = append(orderedIDs, id.String())
	}

	if err := s.bookmarks.Reorder(ctx, folderID, orderedIDs); err != nil {
		s.log.Error("ReorderBookmarks: domain error", "err", err)
		switch {
		case errors.Is(err, bookmarks.ErrNotFound):
			return ReorderBookmarks404JSONResponse(newError("not_found", "ordered_ids does not match folder membership")), nil
		case errors.Is(err, bookmarks.ErrFolderNotFound):
			return ReorderBookmarks400JSONResponse(newError("invalid_request", "folder not found")), nil
		}
		return nil, errors.New("could not reorder bookmarks")
	}

	return ReorderBookmarks204Response{}, nil
}

// CreateBookmarkFolder implements POST /api/v1/bookmark-folders.
//
//nolint:revive // generated interface name
func (s *Server) CreateBookmarkFolder(
	ctx context.Context,
	req CreateBookmarkFolderRequestObject,
) (CreateBookmarkFolderResponseObject, error) {
	defer s.trackWrite()()
	if req.Body == nil {
		return CreateBookmarkFolder400JSONResponse(newError("invalid_request", "request body required")), nil
	}

	f, err := s.bookmarks.CreateFolder(ctx, req.Body.Name)
	if err != nil {
		s.log.Error("CreateBookmarkFolder: domain error", "name", req.Body.Name, "err", err)
		switch {
		case errors.Is(err, bookmarks.ErrInvalidName):
			return CreateBookmarkFolder400JSONResponse(newError("invalid_request", "name must not be empty")), nil
		case errors.Is(err, bookmarks.ErrDuplicateFolderName):
			return CreateBookmarkFolder409JSONResponse(newError("conflict", duplicateFolderNameMessage)), nil
		}
		return nil, errors.New("could not create bookmark folder")
	}

	wireFolder, err := toWireFolder(f)
	if err != nil {
		s.log.Error("CreateBookmarkFolder: could not encode response", "err", err)
		return nil, errors.New("could not create bookmark folder")
	}
	return CreateBookmarkFolder201JSONResponse(wireFolder), nil
}

const duplicateFolderNameMessage = "a folder with this name already exists"
// RenameBookmarkFolder implements PUT /api/v1/bookmark-folders/{id}.
//
//nolint:revive // generated interface name
func (s *Server) RenameBookmarkFolder(
	ctx context.Context,
	req RenameBookmarkFolderRequestObject,
) (RenameBookmarkFolderResponseObject, error) {
	defer s.trackWrite()()
	if req.Body == nil {
		return RenameBookmarkFolder400JSONResponse(newError("invalid_request", "request body required")), nil
	}

	id := openapi_types.UUID(req.Id).String()
	f, err := s.bookmarks.RenameFolder(ctx, id, req.Body.Name)
	if err != nil {
		s.log.Error("RenameBookmarkFolder: domain error", "id", id, "name", req.Body.Name, "err", err)
		switch {
		case errors.Is(err, bookmarks.ErrInvalidName):
			return RenameBookmarkFolder400JSONResponse(newError("invalid_request", "name must not be empty")), nil
		case errors.Is(err, bookmarks.ErrFolderNotFound):
			return RenameBookmarkFolder404JSONResponse(newError("not_found", "bookmark folder not found")), nil
		case errors.Is(err, bookmarks.ErrDuplicateFolderName):
			return RenameBookmarkFolder409JSONResponse(newError("conflict", duplicateFolderNameMessage)), nil
		}
		return nil, errors.New("could not rename bookmark folder")
	}

	wireFolder, err := toWireFolder(f)
	if err != nil {
		s.log.Error("RenameBookmarkFolder: could not encode response", "err", err)
		return nil, errors.New("could not rename bookmark folder")
	}
	return RenameBookmarkFolder200JSONResponse(wireFolder), nil
}

// DeleteBookmarkFolder implements DELETE /api/v1/bookmark-folders/{id}.
//
//nolint:revive // generated interface name
func (s *Server) DeleteBookmarkFolder(
	ctx context.Context,
	req DeleteBookmarkFolderRequestObject,
) (DeleteBookmarkFolderResponseObject, error) {
	defer s.trackWrite()()
	id := openapi_types.UUID(req.Id).String()
	if err := s.bookmarks.DeleteFolder(ctx, id); err != nil {
		s.log.Error("DeleteBookmarkFolder: domain error", "id", id, "err", err)
		if errors.Is(err, bookmarks.ErrFolderNotFound) {
			return DeleteBookmarkFolder404JSONResponse(newError("not_found", "bookmark folder not found")), nil
		}
		return nil, errors.New("could not delete bookmark folder")
	}
	return DeleteBookmarkFolder204Response{}, nil
}

// toWireDocument converts a bookmarks.Bookmarks document to its wire shape.
// Rows that fail to parse as UUIDs (should never happen — IDs are always
// server-generated via uuid.NewString()) are logged and skipped rather than
// failing the whole request.
func (s *Server) toWireDocument(doc bookmarks.Bookmarks) BookmarksDocument {
	folders := make([]BookmarkFolder, 0, len(doc.Folders))
	for _, f := range doc.Folders {
		wf, err := toWireFolder(f)
		if err != nil {
			s.log.Warn("toWireDocument: skipping malformed folder id", "id", f.ID, "err", err)
			continue
		}
		folders = append(folders, wf)
	}

	bms := make([]Bookmark, 0, len(doc.Bookmarks))
	for _, bm := range doc.Bookmarks {
		wb, err := toWireBookmark(bm)
		if err != nil {
			s.log.Warn("toWireDocument: skipping malformed bookmark id", "id", bm.ID, "err", err)
			continue
		}
		bms = append(bms, wb)
	}

	return BookmarksDocument{Folders: folders, Bookmarks: bms}
}

func toWireBookmark(bm bookmarks.Bookmark) (Bookmark, error) {
	id, err := uuid.Parse(bm.ID)
	if err != nil {
		return Bookmark{}, err
	}
	noteID, err := uuid.Parse(bm.NoteID)
	if err != nil {
		return Bookmark{}, err
	}
	folderID, err := stringPtrToUUIDPtr(bm.FolderID)
	if err != nil {
		return Bookmark{}, err
	}
	return Bookmark{
		Id:       openapi_types.UUID(id),
		NoteId:   openapi_types.UUID(noteID),
		FolderId: folderID,
		Order:    bm.Order,
	}, nil
}

func toWireFolder(f bookmarks.Folder) (BookmarkFolder, error) {
	id, err := uuid.Parse(f.ID)
	if err != nil {
		return BookmarkFolder{}, err
	}
	return BookmarkFolder{Id: openapi_types.UUID(id), Name: f.Name}, nil
}

func uuidPtrToStringPtr(id *openapi_types.UUID) *string {
	if id == nil {
		return nil
	}
	s := id.String()
	return &s
}

func stringPtrToUUIDPtr(id *string) (*openapi_types.UUID, error) {
	if id == nil {
		return nil, nil
	}
	parsed, err := uuid.Parse(*id)
	if err != nil {
		return nil, err
	}
	wire := openapi_types.UUID(parsed)
	return &wire, nil
}
