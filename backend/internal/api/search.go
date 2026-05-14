package api

// search.go — Plan 07-04: SearchNotes handler for GET /api/v1/search.
//
// This file is the single source of truth for the full-text search handler.
// Plan 07-04 is also the final stub-remover for handlers_phase7_stubs.go
// (which was deleted by this plan once SearchNotes was the last remaining stub).
//
// Security mitigations (per threat model):
//   - T-7-08 (FTS5 injection): MATCH clause uses bind parameters exclusively;
//     ErrFTSQuerySyntax → HTTP 400 so callers never get a 500 from a bad query.
//   - T-7-09 (DoS): limit clamped to [1, 100] at handler level; SQL LIMIT
//     is limit+1 (detect hasMore), result is capped to limit at return.
//   - T-7-10 (malformed query crashes): strings.Contains("fts5: syntax error")
//     in SearchFTS maps to ErrFTSQuerySyntax → 400 in handler.

import (
	"context"
	"errors"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// SearchNotes implements GET /api/v1/search (SEARCH-01..04).
//
// Parameters:
//   - q     (required): full-text search query; < 2 chars → 200 empty results.
//   - tag   (optional): AND-combine with tag filter (D-05).
//   - limit (optional): max results; default 50, clamped [1, 100].
//
//nolint:revive // generated interface name
func (s *Server) SearchNotes(
	ctx context.Context,
	req SearchNotesRequestObject,
) (SearchNotesResponseObject, error) {
	// --- Extract params ---
	q := req.Params.Q
	tag := ""
	if req.Params.Tag != nil {
		tag = *req.Params.Tag
	}
	limit := 50
	if req.Params.Limit != nil {
		limit = int(*req.Params.Limit)
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}

	// --- Short-query fast path ---
	// Client-side debounce normally prevents < 2-char queries, but be defensive.
	if len(q) < 2 {
		return SearchNotes200JSONResponse{Results: []SearchResult{}}, nil
	}

	// --- Nil-index fast path (Phase 1 / test compatibility) ---
	if s.index == nil {
		return SearchNotes200JSONResponse{Results: []SearchResult{}}, nil
	}

	// --- FTS5 query ---
	hits, err := s.index.SearchFTS(ctx, q, tag, limit)
	if err != nil {
		if errors.Is(err, notes.ErrFTSQuerySyntax) {
			// T-7-10: malformed FTS5 query → 400, code='invalid_query'.
			return SearchNotes400JSONResponse(newError("invalid_query", "Invalid search query.")), nil
		}
		s.log.Error("SearchNotes: index error", "q", q, "tag", tag, "err", err)
		return nil, errors.New("search failed")
	}

	// Cap at limit (SearchFTS returns up to limit+1 to let callers detect hasMore;
	// the +1 overflow slice is discarded here — the UI handles pagination separately).
	if len(hits) > limit {
		hits = hits[:limit]
	}

	results := make([]SearchResult, 0, len(hits))
	for _, h := range hits {
		results = append(results, SearchResult{
			Id:           h.ID,
			Title:        h.Title,
			Path:         h.Path,
			ExcerptHtml:  h.ExcerptHTML,
			MatchingTags: h.MatchingTags,
			Rank:         float32(h.Rank),
			ModifiedAt:   h.ModifiedAt,
		})
	}
	return SearchNotes200JSONResponse{Results: results}, nil
}
