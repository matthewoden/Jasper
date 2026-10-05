package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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

	data, ok := s.firstMatchingBlobPath(blob)
	if !ok {
		return GetBlob404JSONResponse(newError("not_found", "blob not found")), nil
	}
	return GetBlob200ApplicationoctetStreamResponse{
		Body:          bytes.NewReader(data),
		ContentLength: int64(len(data)),
	}, nil
}

// firstMatchingBlobPath reads blob's paths in order and returns the first one
// whose bytes still hash to the blob's digest. The index lags edits made
// outside Jasper until the next reconcile, so a path alone proves nothing.
func (s *Server) firstMatchingBlobPath(blob index.Blob) ([]byte, bool) {
	for _, p := range blob.Paths {
		cleanFinal, _, err := fsstore.ResolveContained(s.notesRoot(), p)
		if err != nil {
			if !os.IsNotExist(err) {
				s.log.Warn("GetBlob: resolve", "path", p, "err", err)
			}
			continue
		}
		data, err := os.ReadFile(cleanFinal)
		if err != nil {
			if !os.IsNotExist(err) {
				s.log.Warn("GetBlob: read", "path", cleanFinal, "err", err)
			}
			continue
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) == blob.SHA256 {
			return data, true
		}
	}
	return nil, false
}
