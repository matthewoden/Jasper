package api

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

var osreleasePath = "/proc/sys/kernel/osrelease"

var (
	revealDarwinFn = revealOnDarwin
	revealWSL2Fn   = revealOnWSL2
	revealLinuxFn  = revealOnLinux
)

// PostReveal implements POST /api/v1/reveal — opens the host OS file manager
// at the requested vault-relative path. See file header for design.
//
//nolint:revive // generated interface method name
func (s *Server) PostReveal(
	ctx context.Context,
	req PostRevealRequestObject,
) (PostRevealResponseObject, error) {
	if req.Body == nil {
		return PostReveal400JSONResponse(newError("invalid_request", "missing body")), nil
	}
	relPath := req.Body.Path
	if relPath == "" {
		return PostReveal400JSONResponse(newError("invalid_path", "path is required")), nil
	}

	abs, errResp := s.resolveRevealPath(relPath)
	if errResp != nil {
		return errResp, nil
	}

	switch runtime.GOOS {
	case "darwin":
		if err := revealDarwinFn(ctx, abs); err != nil {
			s.log.Error("PostReveal: darwin dispatch failed", "path", abs, "err", err)
			return PostReveal500JSONResponse(newError("exec_failed", "Could not open file manager")), nil
		}
		return PostReveal200JSONResponse{Platform: Darwin}, nil

	case "linux":
		if isWSL() {
			if err := revealWSL2Fn(ctx, abs); err != nil {
				s.log.Error("PostReveal: wsl2 dispatch failed", "path", abs, "err", err)
				return PostReveal500JSONResponse(newError("exec_failed", "Could not open file manager")), nil
			}
			return PostReveal200JSONResponse{Platform: Wsl2}, nil
		}

		if err := revealLinuxFn(ctx, abs); err != nil {
			s.log.Error("PostReveal: linux dispatch failed", "path", abs, "err", err)
			return PostReveal500JSONResponse(newError("exec_failed", "Could not open file manager")), nil
		}
		return PostReveal200JSONResponse{Platform: Linux}, nil

	default:
		return PostReveal501JSONResponse(newError("not_supported", "platform not supported")), nil
	}
}

func (s *Server) resolveRevealPath(relPath string) (string, PostRevealResponseObject) {
	if strings.Contains(relPath, "..") {
		return "", PostReveal400JSONResponse(newError("invalid_path", "path must not contain .."))
	}
	if filepath.IsAbs(relPath) || strings.HasPrefix(relPath, "/") || strings.HasPrefix(relPath, `\`) {
		return "", PostReveal400JSONResponse(newError("invalid_path", "path must be relative"))
	}

	cleanRel := filepath.Clean(relPath)
	if cleanRel == "" || cleanRel == "." {
		return "", PostReveal400JSONResponse(newError("invalid_path", "path resolves empty"))
	}

	notesRoot := filepath.Join(s.dataDir, "notes")
	candidate := filepath.Join(notesRoot, cleanRel)
	cleanFinal := filepath.Clean(candidate)
	cleanRoot := filepath.Clean(notesRoot)
	cleanRootWithSep := cleanRoot + string(os.PathSeparator)
	if cleanFinal != cleanRoot && !strings.HasPrefix(cleanFinal, cleanRootWithSep) {
		return "", PostReveal400JSONResponse(newError("invalid_path", "path escapes notes root"))
	}

	fi, err := os.Lstat(cleanFinal)
	if err != nil {
		return "", PostReveal400JSONResponse(newError("invalid_path", "target does not exist"))
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return "", PostReveal400JSONResponse(newError("invalid_path", "symlinks not permitted"))
	}

	return cleanFinal, nil
}

func revealOnDarwin(ctx context.Context, abs string) error {
	return exec.CommandContext(ctx, "open", "-R", abs).Run()
}

func revealOnWSL2(ctx context.Context, abs string) error {
	winPathBytes, err := exec.CommandContext(ctx, "wslpath", "-w", abs).Output()
	if err != nil {
		return fmt.Errorf("wslpath: %w", err)
	}
	winPath := strings.TrimSpace(string(winPathBytes))

	cmd := exec.CommandContext(ctx, "explorer.exe", "/select,"+winPath)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("explorer.exe start: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func revealOnLinux(ctx context.Context, abs string) error {
	target := abs
	if fi, err := os.Lstat(abs); err == nil && !fi.IsDir() {
		target = filepath.Dir(abs)
	}
	return exec.CommandContext(ctx, "xdg-open", target).Run()
}

func isWSL() bool {
	b, err := os.ReadFile(osreleasePath)
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(b)), "microsoft")
}
