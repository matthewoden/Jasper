package api

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/matthewoden/jasper/backend/internal/notes"
)

// GetNoteByPath implements GET /api/v1/notes/by-path?path=<rel>.
//
// Pipeline:
//
//  1. Reject `..`, absolute paths, and Windows-style `\` prefixes.
//  2. filepath.Clean and refuse empty/"."/"/" residue.
//  3. Require `.md` suffix (deep-links target notes, not folders or attachments).
//  4. Canonicalize via NFC + lowercase — the indexer stores paths in this form.
//  5. s.index.LookupByPath: on hit → 200 NoteSummary; on
//     notes.ErrNotFound → 404 "not_found"; on other err → 500.
//
// Returns 404 when s.index is nil (deep-links are useless without the indexer).
//
//nolint:revive // generated interface name
func (s *Server) GetNoteByPath(
	ctx context.Context,
	req GetNoteByPathRequestObject,
) (GetNoteByPathResponseObject, error) {
	rawPath := req.Params.Path

	if strings.Contains(rawPath, "..") ||
		strings.HasPrefix(rawPath, "/") ||
		strings.HasPrefix(rawPath, `\`) ||
		filepath.IsAbs(rawPath) {
		return GetNoteByPath400JSONResponse(newError("invalid_path",
			"path must not contain '..' or be absolute")), nil
	}

	cleanRel := filepath.Clean(rawPath)
	if cleanRel == "" || cleanRel == "." || cleanRel == "/" {
		return GetNoteByPath400JSONResponse(newError("invalid_path",
			"path resolves empty after clean")), nil
	}

	if !strings.HasSuffix(strings.ToLower(cleanRel), ".md") {
		return GetNoteByPath400JSONResponse(newError("invalid_path",
			"path must end in .md")), nil
	}

	canonRel := strings.ToLower(cleanRel)

	if s.index == nil {
		return GetNoteByPath404JSONResponse(newError("not_found",
			"no note at "+rawPath)), nil
	}

	rec, err := s.index.LookupByPath(ctx, canonRel)
	if err != nil {
		if errors.Is(err, notes.ErrNotFound) {
			return GetNoteByPath404JSONResponse(newError("not_found",
				"no note at "+rawPath)), nil
		}
		s.log.Error(
			"GetNoteByPath: index lookup failed",
			"path", canonRel,
			"err", err,
		)

		return nil, errors.New("could not look up note")
	}

	return GetNoteByPath200JSONResponse{
		Id:        openapi_types.UUID(rec.ID),
		Path:      rec.Path,
		Title:     rec.Title,
		UpdatedAt: time.Unix(rec.MTimeUnix, 0).UTC(),
	}, nil
}
