package api

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/matthewoden/jasper/backend/internal/platform"
	"github.com/matthewoden/jasper/backend/internal/vault"
)

var isWSLProbe = platform.IsWSL

// GetFsList implements GET /api/v1/fs/list?path=...
//
//nolint:revive // generated interface name
func (s *Server) GetFsList(
	_ context.Context,
	req GetFsListRequestObject,
) (GetFsListResponseObject, error) {
	raw := ""
	if req.Params.Path != nil {
		raw = *req.Params.Path
	}
	if raw == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return GetFsList400JSONResponse(newError("no_home",
				"could not resolve $HOME; pass ?path=<absolute path>")), nil
		}
		raw = home
	}

	if !filepath.IsAbs(raw) {
		return GetFsList400JSONResponse(newError("not_absolute",
			"path must be absolute")), nil
	}

	abs := filepath.Clean(raw)

	info, statErr := os.Stat(abs)
	if statErr != nil {
		switch {
		case errors.Is(statErr, os.ErrPermission):
			return GetFsList403JSONResponse(newError("permission_denied",
				fmt.Sprintf("permission denied: %s", abs))), nil
		case errors.Is(statErr, os.ErrNotExist):

			return GetFsList400JSONResponse(newError("not_found",
				fmt.Sprintf("no such directory: %s", abs))), nil
		default:
			return GetFsList400JSONResponse(newError("stat_failed",
				statErr.Error())), nil
		}
	}
	if !info.IsDir() {
		return GetFsList400JSONResponse(newError("not_a_directory",
			fmt.Sprintf("path is not a directory: %s", abs))), nil
	}

	entries, readErr := os.ReadDir(abs)
	if readErr != nil {
		if errors.Is(readErr, os.ErrPermission) {
			return GetFsList403JSONResponse(newError("permission_denied",
				fmt.Sprintf("permission denied reading: %s", abs))), nil
		}
		return GetFsList400JSONResponse(newError("readdir_failed",
			readErr.Error())), nil
	}

	subdirs := make([]FsListEntry, 0, len(entries))
	for _, e := range entries {
		name := e.Name()

		if strings.HasPrefix(name, ".") {
			continue
		}

		if e.IsDir() {
			subdirs = append(subdirs, FsListEntry{
				Name: name,
				Path: filepath.Join(abs, name),
			})
			continue
		}

		if e.Type()&os.ModeSymlink != 0 {
			linkInfo, linkErr := os.Stat(filepath.Join(abs, name))
			if linkErr == nil && linkInfo.IsDir() {
				subdirs = append(subdirs, FsListEntry{
					Name: name,
					Path: filepath.Join(abs, name),
				})
			}
		}
	}

	sort.Slice(subdirs, func(i, j int) bool {
		return strings.ToLower(subdirs[i].Name) < strings.ToLower(subdirs[j].Name)
	})

	parent := filepath.Dir(abs)
	if parent == abs {
		parent = ""
	}

	var winPath *string
	if isWSLProbe() {
		if w := platform.WslToWindows(abs); w != "" {
			winPath = &w
		}
	}

	isVaultPtr := isVaultMarker(filepath.Join(abs, ".jasper"))

	return GetFsList200JSONResponse(FsListResponse{
		Path:        abs,
		Parent:      parent,
		WindowsPath: winPath,
		IsVault:     isVaultPtr,
		Entries:     subdirs,
	}), nil
}

func isVaultMarker(jasperDir string) *bool {
	info, statErr := os.Stat(jasperDir)
	if statErr != nil || !info.IsDir() {
		return nil
	}

	rawAppHome, appHomeErr := vault.AppHomePath()
	if appHomeErr == nil {
		appHomeCanon, cErr := vault.Canonicalize(rawAppHome)
		if cErr == nil {
			jasperCanon, jcErr := vault.Canonicalize(jasperDir)
			if jcErr == nil && jasperCanon == appHomeCanon {
				falseVal := false
				return &falseVal
			}
		}
	}
	trueVal := true
	return &trueVal
}
