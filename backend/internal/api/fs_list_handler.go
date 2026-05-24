package api

// fs_list_handler.go — GET /api/v1/fs/list?path=... (UAT-2 #1d folder picker).
//
// Powers the vault picker's "Browse…" modal. The user shouldn't have to type
// an absolute path; this endpoint enumerates the subdirectories of an arbitrary
// directory on the host filesystem so the frontend can render a breadcrumb +
// clickable folder list.
//
// Threat model: Jasper runs as the local user, bound to loopback. The user
// already has shell-level filesystem access at their own privilege level, so
// this handler doesn't introduce an escalation — it just enumerates what the
// user could `ls` themselves. We still:
//   - Reject non-absolute paths (the picker always sends absolutes; relative
//     inputs are almost certainly programmer error or a probe).
//   - Canonicalize via filepath.Abs + filepath.Clean — NO EvalSymlinks on the
//     parent (a symlink should be browseable as itself, not silently resolved).
//   - Map os.ErrNotExist → 400 (so a typo in the path doesn't tell a snooping
//     loopback caller which directories exist).
//   - Map os.ErrPermission → 403 so the picker can render a "no permission"
//     state distinctly.
//   - Filter to directory entries only (we're picking folders, not files).
//   - Skip dotfile directories (`.git`, `.cache`, etc.) since they clutter the
//     picker — the user can still type the path manually if they really want
//     to vault inside a dotfile dir.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// GetFsList implements GET /api/v1/fs/list?path=...
//
//nolint:revive // generated interface name
func (s *Server) GetFsList(
	_ context.Context,
	req GetFsListRequestObject,
) (GetFsListResponseObject, error) {
	// Default to $HOME when no path is given so the picker boots into a
	// useful place. UserHomeDir failure is a vanishingly rare environment
	// problem; surface it as a 400 with a clear message rather than 500ing.
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

	// Rule: absolute paths only. The picker constructs paths client-side from
	// previous responses' canonical `path` field, so a non-absolute input is
	// almost certainly a probe or programmer error.
	if !filepath.IsAbs(raw) {
		return GetFsList400JSONResponse(newError("not_absolute",
			"path must be absolute")), nil
	}

	// Canonicalize. We deliberately do NOT EvalSymlinks here — a symlinked
	// folder should be browseable as itself; the user can decide whether to
	// follow links once they see the entries.
	abs := filepath.Clean(raw)

	// Stat the directory itself so we can distinguish "missing" (400) from
	// "permission denied" (403) before ReadDir conflates them in some envs.
	info, statErr := os.Stat(abs)
	if statErr != nil {
		switch {
		case errors.Is(statErr, os.ErrPermission):
			return GetFsList403JSONResponse(newError("permission_denied",
				fmt.Sprintf("permission denied: %s", abs))), nil
		case errors.Is(statErr, os.ErrNotExist):
			// 400 (not 404) on purpose — see file comment.
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
		// Skip dotfile directories — they're noise in a folder picker.
		// Users can still target them by typing the path manually.
		if strings.HasPrefix(name, ".") {
			continue
		}
		// Resolve dir-ness via Type() (no extra stat unless it's a symlink).
		// If we can't tell, fall back to Stat — entries we can't stat are
		// just silently skipped (the picker shouldn't crash on a stale entry).
		if e.IsDir() {
			subdirs = append(subdirs, FsListEntry{
				Name: name,
				Path: filepath.Join(abs, name),
			})
			continue
		}
		// Symlink to a dir: follow once via Stat (Type() returned the link
		// type, not the target's). Errors silently skip the entry.
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

	// Case-insensitive alphabetical so the picker order matches what users
	// see in Finder/Files browsers.
	sort.Slice(subdirs, func(i, j int) bool {
		return strings.ToLower(subdirs[i].Name) < strings.ToLower(subdirs[j].Name)
	})

	// Parent. Empty when we're at the filesystem root (no breadcrumb-back).
	parent := filepath.Dir(abs)
	if parent == abs {
		parent = ""
	}

	return GetFsList200JSONResponse(FsListResponse{
		Path:    abs,
		Parent:  parent,
		Entries: subdirs,
	}), nil
}
