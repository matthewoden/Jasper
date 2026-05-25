package api

// fs_mkdir_handler.go — POST /api/v1/fs/mkdir.
//
// Powers the vault picker's "New folder" affordance so the user can prep
// an empty folder for vault creation without bouncing out to Finder /
// Explorer. Same threat model as /fs/list: Jasper runs as the local user,
// bound to loopback, so this is just "mkdir on the user's behalf" — no
// escalation, no surface the user couldn't already reach via a shell.
//
// Validation pipeline mirrors validateVaultPath in vault.go so the
// folder names you can mkdir here are the same shape you can later vault
// in (ASCII / NFC / no `..` / no `//`). The path must be absolute.
// Parent must exist (no implicit MkdirAll deep tree creation — the
// picker is for "new sibling here," not for typing arbitrary paths).
//
// Idempotent on success: if the directory already exists and is a
// directory, return 200 with the canonical path. If it exists but is a
// file, return 400 not_a_directory.

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
	// Reuse the vault-path validator — ASCII + NFC + no `..` + no `//`.
	// Folder names that fail this are also names you couldn't safely vault
	// in later, so rejecting them here saves the user an "I made the folder
	// but can't use it" surprise.
	if err := validateVaultPath(raw); err != nil {
		return PostFsMkdir400JSONResponse(newError("invalid_path", err.Error())), nil
	}

	// Canonicalize the PARENT only — vault.Canonicalize lowercases on
	// darwin so feeding it the full path would create
	// "brand new folder" on disk when the user typed "Brand New Folder".
	// On APFS the OS records the case as written; we just need to make
	// sure we don't pre-lowercase it ourselves.
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

	// Idempotent on success: if it already exists AND is a directory, 200.
	// If it exists but is a file, surface a clear error rather than the
	// confusing EEXIST that os.Mkdir would otherwise return.
	if info, statErr := os.Stat(canonical); statErr == nil {
		if !info.IsDir() {
			return PostFsMkdir400JSONResponse(newError("not_a_directory",
				fmt.Sprintf("path exists and is not a directory: %s", canonical))), nil
		}
		return PostFsMkdir200JSONResponse(FsMkdirResponse{Path: canonical}), nil
	}

	// Single-level Mkdir, not MkdirAll — parent existence is already
	// confirmed above; if Mkdir errors we want the real reason
	// (permission, EEXIST race, etc.) rather than silently recursing.
	if err := os.Mkdir(canonical, 0o755); err != nil {
		if errors.Is(err, os.ErrPermission) {
			return PostFsMkdir403JSONResponse(newError("permission_denied",
				fmt.Sprintf("permission denied creating: %s", canonical))), nil
		}
		return PostFsMkdir400JSONResponse(newError("mkdir_failed", err.Error())), nil
	}
	return PostFsMkdir200JSONResponse(FsMkdirResponse{Path: canonical}), nil
}
