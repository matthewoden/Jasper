package api

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path"
	"strings"

	"github.com/matthewoden/jasper/backend/internal/fsstore"
	"github.com/matthewoden/jasper/backend/internal/index"
	"github.com/matthewoden/jasper/backend/internal/notes"
)

// GetItemsSearch implements GET /api/v1/items/search, backing the @ picker.
// Notes come from the title search; blobs from the attachment index, which
// only the concrete indexer carries.
func (s *Server) GetItemsSearch(
	ctx context.Context,
	req GetItemsSearchRequestObject,
) (GetItemsSearchResponseObject, error) {
	q := ""
	if req.Params.Q != nil {
		q = strings.TrimSpace(*req.Params.Q)
	}
	limit := 10
	if req.Params.Limit != nil {
		limit = int(*req.Params.Limit)
	}
	if limit > 50 {
		limit = 50
	}
	if limit < 1 {
		limit = 1
	}
	if s.index == nil {
		return GetItemsSearch200JSONResponse{Items: []ItemSearchHit{}}, nil
	}

	hits, err := s.index.SearchTitles(ctx, q, limit)
	if err != nil {
		s.log.Error("GetItemsSearch: title search", "q", q, "err", err)
		return nil, errors.New("search failed")
	}
	out := make([]ItemSearchHit, 0, len(hits)+limit)
	for _, h := range hits {
		out = append(out, ItemSearchHit{Ref: notes.RefForNote(h.ID), Kind: ItemSearchHitKindNote, Title: h.Title, Path: h.Path})
	}
	if idx, ok := s.index.(*index.Indexer); ok && q != "" {
		blobs, err := idx.SearchBlobNames(ctx, q, limit)
		if err != nil {
			s.log.Error("GetItemsSearch: blob search", "q", q, "err", err)
			return nil, errors.New("search failed")
		}
		for _, b := range blobs {
			out = append(out, ItemSearchHit{Ref: notes.RefForBlob(b.ID), Kind: ItemSearchHitKindBlob, Title: path.Base(b.Path), Path: b.Path})
		}
	}
	return GetItemsSearch200JSONResponse{Items: out}, nil
}

// GetBlob implements GET /api/v1/blobs/{blobId}: the first live path holding
// the bytes, resolved like an attachment.
func (s *Server) GetBlob(
	ctx context.Context,
	req GetBlobRequestObject,
) (GetBlobResponseObject, error) {
	idx, ok := s.index.(*index.Indexer)
	if !ok || idx == nil {
		return GetBlob404JSONResponse(newError("not_found", "blob not found")), nil
	}
	blob, found, err := idx.GetBlob(ctx, req.BlobId)
	if err != nil {
		s.log.Error("GetBlob: lookup", "id", req.BlobId, "err", err)
		return nil, errors.New("could not read blob")
	}
	if !found || len(blob.Paths) == 0 {
		return GetBlob404JSONResponse(newError("not_found", "blob not found")), nil
	}

	cleanFinal, _, resolveErr := fsstore.ResolveContained(s.notesRoot(), blob.Paths[0])
	switch {
	case resolveErr == nil:
	case os.IsNotExist(resolveErr):
		return GetBlob404JSONResponse(newError("not_found", "blob not found")), nil
	default:
		s.log.Error("GetBlob: resolve", "path", blob.Paths[0], "err", resolveErr)
		return nil, errors.New("could not read blob")
	}
	data, readErr := os.ReadFile(cleanFinal)
	if readErr != nil {
		s.log.Error("GetBlob: read", "path", cleanFinal, "err", readErr)
		return nil, errors.New("could not read blob")
	}
	return GetBlob200ApplicationoctetStreamResponse{
		Body:          bytes.NewReader(data),
		ContentLength: int64(len(data)),
	}, nil
}
