package api

// reveal_handler.go — POST /api/v1/reveal handler (SHARE-01, D-26, D-27, D-28).
//
// Opens the host OS file manager focused on a note or folder under the vault.
// Platform-switched at runtime:
//
//   - darwin (macOS):   exec "open" "-R" <abs>           → Finder opens, file selected
//   - linux (WSL2):     exec "wslpath" "-w" <abs>        → translate to Windows path
//                       exec "explorer.exe" "/select,<wp>" → Explorer opens, file selected
//   - linux (native):   501 + friendly message naming the abs path (D-28; v1 scope)
//   - other GOOS:       501 + generic "not supported" message
//
// Path-traversal hardened with the same 5-rule pipeline as files.go GetFile
// (SECURITY-06 / T-08-20). Reveal accepts BOTH files and folders (D-26 — the
// 4 mount points include note rows, folder rows, file rows, and breadcrumb
// segments).
//
// Threat mitigations (08-05 threat register):
//
//   - T-08-20 Path traversal: 5-rule pipeline rejects '..', absolute paths,
//     empty residue, prefix-escape, and symlinks (via Lstat) BEFORE any exec.
//   - T-08-21 Command injection: Go's exec.Command passes each argv as a
//     discrete string — no shell interpolation. wslpath stdout is consumed
//     as a single argv element for explorer.exe.
//   - T-08-22 Information disclosure: handler returns generic toast strings;
//     the os/exec error is logged server-side via s.log.Error only.
//   - T-08-23 Symlink spoofing: os.Lstat (not Stat) is used so any symlink
//     under the vault is rejected regardless of target.
//   - T-08-24 DoS via hung child: exec.CommandContext binds the child to the
//     HTTP request ctx — cancellation aborts the child process.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// osreleasePath is the file inspected by isWSL to decide whether the current
// Linux host is WSL2. Overridable in tests; production path is
// /proc/sys/kernel/osrelease (kernel exposes the build name including
// "microsoft" on WSL kernels — case-insensitive match).
var osreleasePath = "/proc/sys/kernel/osrelease"

// revealDarwinFn / revealWSL2Fn are the exec dispatchers, factored out as
// package vars so reveal_handler_test.go can swap them with table-driven
// fakes without shelling out. Production values use exec.CommandContext.
var (
	revealDarwinFn = revealOnDarwin
	revealWSL2Fn   = revealOnWSL2
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
		// D-28: native Linux is out of v1 scope. Surface the abs path so the
		// user can copy it into another tool. UI-SPEC §Copywriting toast.
		return PostReveal501JSONResponse(newError("not_supported",
			fmt.Sprintf("Show in file manager isn't supported on Linux yet. The file is at %s.", abs))), nil

	default:
		return PostReveal501JSONResponse(newError("not_supported", "platform not supported")), nil
	}
}

// resolveRevealPath runs the 5-rule path-traversal pipeline on relPath and
// returns the absolute path under the vault, or a typed 400 response if any
// rule fails. Mirrors files.go GetFile but accepts directories (D-26).
//
// The returned PostRevealResponseObject is non-nil iff the path is invalid;
// callers should bubble it up unchanged (handler returns nil error so the
// strict-server runtime renders the 400 body).
func (s *Server) resolveRevealPath(relPath string) (string, PostRevealResponseObject) {
	// Rule 1: reject '..' and absolute paths (POSIX '/' and Windows '\').
	if strings.Contains(relPath, "..") {
		return "", PostReveal400JSONResponse(newError("invalid_path", "path must not contain .."))
	}
	if filepath.IsAbs(relPath) || strings.HasPrefix(relPath, "/") || strings.HasPrefix(relPath, `\`) {
		return "", PostReveal400JSONResponse(newError("invalid_path", "path must be relative"))
	}
	// Rule 2: clean; reject empty residue.
	cleanRel := filepath.Clean(relPath)
	if cleanRel == "" || cleanRel == "." {
		return "", PostReveal400JSONResponse(newError("invalid_path", "path resolves empty"))
	}
	// Rule 3+4: compute bounding root, prefix-check after final clean.
	notesRoot := filepath.Join(s.dataDir, "notes")
	candidate := filepath.Join(notesRoot, cleanRel)
	cleanFinal := filepath.Clean(candidate)
	cleanRoot := filepath.Clean(notesRoot)
	cleanRootWithSep := cleanRoot + string(os.PathSeparator)
	if cleanFinal != cleanRoot && !strings.HasPrefix(cleanFinal, cleanRootWithSep) {
		return "", PostReveal400JSONResponse(newError("invalid_path", "path escapes notes root"))
	}
	// Rule 5: Lstat (NOT Stat) so symlinks reject without following.
	fi, err := os.Lstat(cleanFinal)
	if err != nil {
		return "", PostReveal400JSONResponse(newError("invalid_path", "target does not exist"))
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return "", PostReveal400JSONResponse(newError("invalid_path", "symlinks not permitted"))
	}
	// Reveal accepts both files and dirs (D-26): no IsDir() check.
	return cleanFinal, nil
}

// revealOnDarwin dispatches `open -R <abs>` to surface Finder with the file
// selected. The ctx ties the child process lifetime to the HTTP request
// (T-08-24).
func revealOnDarwin(ctx context.Context, abs string) error {
	return exec.CommandContext(ctx, "open", "-R", abs).Run()
}

// revealOnWSL2 translates the Linux path to a Windows path via wslpath, then
// invokes explorer.exe with /select,<win-path>. explorer.exe is known to
// exit with status 1 even on success — we use Start (not Run) and drain Wait
// in a goroutine so the response returns immediately and the (harmless)
// non-zero exit does not surface as an error to the caller. (Start succeeds
// once the binary is spawned; the Windows side does the actual selection.)
func revealOnWSL2(ctx context.Context, abs string) error {
	winPathBytes, err := exec.CommandContext(ctx, "wslpath", "-w", abs).Output()
	if err != nil {
		return fmt.Errorf("wslpath: %w", err)
	}
	winPath := strings.TrimSpace(string(winPathBytes))
	// NOTE: explorer.exe with /select,<path> ALWAYS exits with status 1 even
	// when the window opens correctly (long-standing Windows quirk). Treat a
	// successful spawn as success and drain Wait in a goroutine. The /select
	// argv is a single argument — no shell quoting, no command injection.
	cmd := exec.CommandContext(ctx, "explorer.exe", "/select,"+winPath)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("explorer.exe start: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// isWSL returns true when the current Linux host is WSL2 — detected by the
// substring "microsoft" (case-insensitive) in /proc/sys/kernel/osrelease.
// On non-WSL Linux this file does not contain "microsoft"; on macOS / other
// platforms the file usually does not exist and isWSL returns false.
//
// The osreleasePath package var is overridable in tests.
func isWSL() bool {
	b, err := os.ReadFile(osreleasePath)
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(b)), "microsoft")
}
