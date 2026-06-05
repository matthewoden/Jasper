package firstrun

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

const maxDataDirPathLen = 4096

// RefusalCode names one of the five D-08 refusal cases or "" when
// the validation passes. The wire format (api.SetupValidateResponseCode)
// uses the same string constants — so the handler in setup_handler.go
// can cast directly.
type RefusalCode string

// The five D-08 refusal codes. Strings match openapi.yaml's
// SetupValidateResponseCode enum (generated as
// api.SetupValidateResponseCode constants ParentMissing, NestedVault,
// Unwritable, NonAscii, NotAbsolute).
//
// `not_absolute` was added in the Phase 08 UAT-1 fix
// (debug session firstrun-tilde-not-expanded, 2026-05-18): when the
// user types a relative path (e.g. "Jasper/notes") that ResolveDataDir
// cannot normalise into an absolute path against $HOME, the wizard
// refuses with this code rather than silently materialising a stray
// directory under the binary's launch CWD. Tilde-prefixed paths
// (`~`, `~/...`) are NOT relative — they are resolved against
// os.UserHomeDir() before this check runs, so the common
// `~/Documents/Jasper` case lands cleanly on the Valid path.
const (
	RefusalParentMissing RefusalCode = "parent_missing"
	RefusalNestedVault   RefusalCode = "nested_vault"
	RefusalUnwritable    RefusalCode = "unwritable"
	RefusalNonASCII      RefusalCode = "non_ascii"
	RefusalNotAbsolute   RefusalCode = "not_absolute"
)

const (
	msgParentMissing = "The parent folder doesn't exist. Create it first, then pick this path."
	msgNestedVault   = "This path is inside an existing Jasper vault. Pick a different folder."
	msgNonASCII      = "Path contains characters that don't survive cross-platform sync. Use plain ASCII letters, digits, dashes, and forward slashes."

	msgUnwritableFmt = "Jasper can't write here: %s. Check folder permissions."

	msgNotAbsolute = "Pick an absolute path (starts with `/`) or a path beginning with `~/`."
)

// ValidateResult is the outcome of ValidateDataDir. Valid is true ONLY
// when none of the D-08 rules fires; otherwise Code carries the
// machine-readable rule name and Message carries the locked UI string.
type ValidateResult struct {
	Valid   bool
	Code    RefusalCode
	Message string
}

// ResolveDataDir normalises a wizard-supplied data-dir path into an
// absolute filesystem path BEFORE any other validation runs. Two
// transforms are applied, in order:
//
//  1. Tilde expansion. A bare "~" or a "~/..." prefix is rewritten
//     against os.UserHomeDir(). The shell convention "~user" (expand
//     against another user's home) is NOT supported — those forms are
//     treated as relative and fall through to the absolute-path check.
//     This matches what users will plausibly type into the wizard input
//     whose placeholder is `~/Documents/Jasper`.
//
//  2. Absolute-path enforcement. After expansion the path MUST be
//     filepath.IsAbs() — otherwise sqlite.Open will reject it later
//     with a confusing "dbPath must be absolute" error, and the
//     write-probe step in ValidateDataDir will silently create a
//     stray directory tree under the binary's launch CWD (the symptom
//     that motivated this helper; see debug
//     firstrun-tilde-not-expanded.md).
//
// On success returns (resolved, "", "") — the resolved path is what
// callers should persist into cfg.Server.DataDir / pass to MkdirAll /
// hand to sqlite.Open. On failure returns ("", code, locked message)
// matching ValidateResult's Code/Message fields exactly.
//
// This function does NO filesystem I/O. It is safe to call from any
// goroutine, and ValidateDataDir + RunSetup both call it.
func ResolveDataDir(raw string) (string, RefusalCode, string) {
	expanded := raw
	if raw == "~" || strings.HasPrefix(raw, "~/") {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return "", RefusalNotAbsolute, msgNotAbsolute
		}
		if raw == "~" {
			expanded = home
		} else {
			expanded = filepath.Join(home, raw[2:])
		}
	}

	if !filepath.IsAbs(expanded) {
		return "", RefusalNotAbsolute, msgNotAbsolute
	}

	return filepath.Clean(expanded), "", ""
}

// ValidateDataDir applies the D-08 refusal rules in order:
//
//  0. tilde-expand + absolute-path check (ResolveDataDir; new in
//     UAT-1 fix — prevents the write-probe from creating a stray "~"
//     directory under the binary's launch CWD).
//  1. non-ASCII / non-NFC (cheap; runs on the resolved path)
//  2. parent directory missing
//  3. nested-vault detection
//  4. write probe (mkdir 0700 + create+remove a tempfile)
//
// The rules are short-circuit: the first that fires returns immediately.
// A "valid" result means the path can be used as the data-dir without
// any further check — RunSetup re-runs ValidateDataDir as a final gate
// to defend against a client that bypasses the debounced /validate-data-dir
// call.
//
// Threat model:
//   - T-08-06 (Tampering): handled by RunSetup re-validation, not here.
//   - T-08-07 (DoS): top-of-function path-length cap at 4096 bytes
//     bounds the work done per request before any filesystem syscall.
//   - T-08-09 (info disclosure): we deliberately surface the underlying
//     os.Error message for the unwritable case because the UI needs
//     actionable remediation. The user is local-host and already
//     controls the filesystem; risk accepted.
func ValidateDataDir(path string) ValidateResult {
	if len(path) > maxDataDirPathLen {
		return ValidateResult{Code: RefusalNonASCII, Message: msgNonASCII}
	}

	resolved, refusalCode, refusalMsg := ResolveDataDir(path)
	if refusalCode != "" {
		return ValidateResult{Code: refusalCode, Message: refusalMsg}
	}
	path = resolved

	if !norm.NFC.IsNormalString(path) {
		return ValidateResult{Code: RefusalNonASCII, Message: msgNonASCII}
	}
	for _, r := range path {
		if r > unicode.MaxASCII {
			return ValidateResult{Code: RefusalNonASCII, Message: msgNonASCII}
		}
	}

	parent := filepath.Dir(path)
	if _, err := os.Stat(parent); errors.Is(err, fs.ErrNotExist) {
		return ValidateResult{Code: RefusalParentMissing, Message: msgParentMissing}
	}

	if isInsideExistingVault(path) {
		return ValidateResult{Code: RefusalNestedVault, Message: msgNestedVault}
	}

	if err := os.MkdirAll(path, 0o700); err != nil {
		return ValidateResult{Code: RefusalUnwritable, Message: fmt.Sprintf(msgUnwritableFmt, err.Error())}
	}
	probe, err := os.CreateTemp(path, ".jasper-write-probe-*")
	if err != nil {
		return ValidateResult{Code: RefusalUnwritable, Message: fmt.Sprintf(msgUnwritableFmt, err.Error())}
	}
	probeName := probe.Name()
	_ = probe.Close()
	_ = os.Remove(probeName)
	return ValidateResult{Valid: true}
}

func isInsideExistingVault(path string) bool {
	cur := filepath.Dir(path)
	for {
		parent := filepath.Dir(cur)
		if parent == cur {
			return false
		}
		if isDir(filepath.Join(parent, "notes")) && fileExists(filepath.Join(parent, "storage", "app.db")) {
			return true
		}
		cur = parent
	}
}

func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
