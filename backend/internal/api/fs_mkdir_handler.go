package api

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/matthewoden/jasper/backend/internal/vault"
)

//nolint:revive // generated interface method name
func (s *Server) PostFsMkdir(
	_ context.Context,
	req PostFsMkdirRequestObject,
) (PostFsMkdirResponseObject, error) {
	if req.Body == nil {
		return PostFsMkdir400JSONResponse(newError("invalid_request", "request body required")), nil
	}
	raw := req.Body.Path
	if !filepath.IsAbs(raw) {
		return PostFsMkdir400JSONResponse(newError("not_absolute", "path must be absolute")), nil
	}

	if err := validateVaultPath(raw); err != nil {
		return PostFsMkdir400JSONResponse(newError("invalid_path", err.Error())), nil
	}

	rawParent := filepath.Dir(raw)
	leaf := filepath.Base(raw)
	parent, cErr := vault.Canonicalize(rawParent)
	if cErr != nil {
		return PostFsMkdir400JSONResponse(newError("invalid_path", cErr.Error())), nil
	}
	canonical := filepath.Join(parent, leaf)
	if _, statErr := os.Stat(parent); statErr != nil {
		if errors.Is(statErr, os.ErrNotExist) {
			return PostFsMkdir400JSONResponse(newError("parent_missing",
				fmt.Sprintf("parent folder does not exist: %s", parent))), nil
		}
		if errors.Is(statErr, os.ErrPermission) {
			return PostFsMkdir403JSONResponse(newError("permission_denied",
				fmt.Sprintf("permission denied: %s", parent))), nil
		}
		return PostFsMkdir400JSONResponse(newError("stat_failed", statErr.Error())), nil
	}

	if info, statErr := os.Stat(canonical); statErr == nil {
		if !info.IsDir() {
			return PostFsMkdir400JSONResponse(newError("not_a_directory",
				fmt.Sprintf("path exists and is not a directory: %s", canonical))), nil
		}
		return PostFsMkdir200JSONResponse(FsMkdirResponse{Path: canonical}), nil
	}

	if err := os.Mkdir(canonical, 0o755); err != nil {
		if errors.Is(err, os.ErrPermission) {
			return PostFsMkdir403JSONResponse(newError("permission_denied",
				fmt.Sprintf("permission denied creating: %s", canonical))), nil
		}
		return PostFsMkdir400JSONResponse(newError("mkdir_failed", err.Error())), nil
	}
	return PostFsMkdir200JSONResponse(FsMkdirResponse{Path: canonical}), nil
}
